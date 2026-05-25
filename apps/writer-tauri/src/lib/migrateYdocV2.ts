// One-shot migration that removes the .ydoc-as-tier-1 footgun.
//
// Why this exists:
//   Phase 2 of the Yjs-removal migration drops both the boot-time
//   `.ydoc` preference inside `applyVaultBodyToYDoc` AND the
//   `flushDirty` write of `.ydoc` files. That makes `.md` the single
//   source of truth on disk going forward, but does NOT recover any
//   doc whose freshest content currently lives in `.ydoc` alone —
//   for example, a doc the user typed into seconds before quit where
//   the auto-flush happened to land `.ydoc` first and the paired
//   `.md` write failed or was overwritten by an external editor
//   between flush ticks.
//
// What this does on the first post-upgrade boot:
//   1. Walk every `.ydoc` file under the vault subfolders.
//   2. For each one, compare its `mtime` against the paired `.md`.
//      When the `.ydoc` is strictly newer, or the `.md` is missing,
//      load the binary into a temp Y.Doc, convert its XmlFragment to
//      a PM document via `yXmlFragmentToProseMirrorRootNode`, run the
//      app's markdown serializer over it, and write the resulting
//      markdown into the `.md` path.
//   3. Drop a sentinel marker `.writer-migration-v2-done` at the
//      vault root so subsequent boots skip the whole walk.
//
// What this does NOT do:
//   - Delete the `.ydoc` files. Phase 7 of the migration runs that
//     bulk cleanup once we're confident no remaining code path reads
//     them. Keeping them around here is the rollback safety net: if a
//     `.md` backfill turns out to have lost something, the binary is
//     still on disk for forensics.
//   - Roll back if the markdown write fails. We log and continue; the
//     sentinel still lands so a permanently-corrupt `.ydoc` doesn't
//     block every future boot.
//
// Idempotency:
//   The sentinel is the only gate. A user who manually deletes it
//   triggers another walk on the next boot — useful if a recovered
//   markdown file gets edited externally and the user wants to
//   re-derive it from `.ydoc`, but in normal use the migration runs
//   exactly once per vault.

import * as Y from 'yjs'
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import { stat } from '@tauri-apps/plugin-fs'
import {
  listVaultDir,
  readVaultBinary,
  vaultFileExists,
  writeVaultFile,
} from '@/lib/vault'
import { resolve as resolvePath } from '@tauri-apps/api/path'
import { getActiveVaultPath } from '@/state/settingsStore'
import { initHeadlessParser } from '@/lib/headlessMilkdown'
import { useEditorViewStore } from '@/state/editorViewStore'

const SENTINEL_REL = '.writer-migration-v2-done'

/** Vault subdirectories that may contain `.ydoc` files. `threads/`
 * is intentionally excluded — chat thread JSON has never been
 * persisted as Yjs binaries, and treating it like doc content here
 * would only widen the blast radius of a buggy walk. */
const WALK_ROOTS = ['wiki', 'daily', '_system'] as const

/** Run the migration once. Safe to call on every boot — the sentinel
 * makes repeated calls a no-op. Vault selection is required; without
 * one we silently skip (BootGate runs the picker before calling us,
 * so the only "no vault" path is the user cancelling the picker). */
export async function migrateYdocV2(): Promise<void> {
  const vault = getActiveVaultPath()
  if (!vault) return

  if (await vaultFileExists(SENTINEL_REL)) return

  // Parser + serializer come from the headless Milkdown that App.tsx
  // booted on module load. Awaiting the same promise here ensures
  // they're ready even if our migration is the first consumer.
  try {
    await initHeadlessParser()
  } catch (err) {
    console.warn(
      '[migration v2] headless parser failed to init; skipping backfill',
      err,
    )
    return
  }

  const { parser, serializer } = useEditorViewStore.getState()
  if (!parser || !serializer) {
    console.warn(
      '[migration v2] parser/serializer not in editorViewStore; skipping',
    )
    return
  }

  // The schema we hand to `yXmlFragmentToProseMirrorRootNode` has to
  // match the one the markdown serializer was built against —
  // otherwise the constructed PM node carries node types the
  // serializer's `toMarkdown` runners don't know, and the serialize
  // call throws. Parsing a tiny probe gives us a real PM node whose
  // `.type.schema` is exactly the one in use.
  const schema = (() => {
    try {
      const probeNode = parser('# probe')
      return probeNode?.type.schema ?? null
    } catch (err) {
      console.warn('[migration v2] probe parse failed', err)
      return null
    }
  })()
  if (!schema) {
    console.warn('[migration v2] could not resolve schema; skipping')
    return
  }

  const ydocFiles = await collectYdocFiles()
  if (ydocFiles.length === 0) {
    await markSentinel()
    return
  }

  let backfilled = 0
  let skipped = 0
  for (const ydocRel of ydocFiles) {
    const mdRel = ydocRel.replace(/\.ydoc$/, '.md')
    const shouldBackfill = await isYdocFresherThanMd(ydocRel, mdRel)
    if (!shouldBackfill) {
      skipped += 1
      continue
    }

    try {
      const markdown = await ydocToMarkdown(ydocRel, schema, serializer)
      if (markdown === null) {
        // Empty / non-text fragment — nothing useful to recover, but
        // not an error either. Counts as skipped so the log reads
        // honestly.
        skipped += 1
        continue
      }
      await writeVaultFile(mdRel, markdown)
      backfilled += 1
    } catch (err) {
      console.warn('[migration v2] backfill failed for', ydocRel, err)
    }
  }

  await markSentinel()
  console.log(
    `[migration v2] backfilled ${backfilled} / skipped ${skipped} (of ${ydocFiles.length} .ydoc files)`,
  )
}

/** Walk the three doc-bearing subdirs and return every `.ydoc` path
 * we find, vault-relative. `listVaultDir` returns immediate children
 * only, so we recurse into subfolders ourselves — daily has child
 * notes nested one level (`daily/2026-05-25/child.md` + `.ydoc`). */
async function collectYdocFiles(): Promise<string[]> {
  const out: string[] = []
  for (const root of WALK_ROOTS) {
    await walkInto(root, out)
  }
  return out
}

async function walkInto(rel: string, out: string[]): Promise<void> {
  if (!(await vaultFileExists(rel))) return
  let entries: string[]
  try {
    entries = await listVaultDir(rel)
  } catch {
    return
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue
    const childRel = `${rel}/${name}`
    if (name.endsWith('.ydoc')) {
      out.push(childRel)
      continue
    }
    // No extension → assume directory. listVaultDir doesn't return
    // entry types, and probing each path with `stat` would double
    // the walk; treating extensionless names as folders matches the
    // vault convention (only `.md` / `.ydoc` / `.meta.json` files
    // live at content paths, every other name is a directory).
    if (!name.includes('.')) {
      await walkInto(childRel, out)
    }
  }
}

/** Decide whether the `.ydoc` is the freshest copy. Three outcomes
 * count as "yes, back this up into `.md`":
 *   - `.md` doesn't exist at all
 *   - `.md` exists but is older than `.ydoc`
 *   - either stat fails (treat the `.ydoc` as the safer source) */
async function isYdocFresherThanMd(
  ydocRel: string,
  mdRel: string,
): Promise<boolean> {
  const vault = getActiveVaultPath()
  if (!vault) return false
  if (!(await vaultFileExists(mdRel))) return true

  try {
    const ydocAbs = await resolvePath(vault, ydocRel)
    const mdAbs = await resolvePath(vault, mdRel)
    const [ydocStat, mdStat] = await Promise.all([stat(ydocAbs), stat(mdAbs)])
    const ydocMs = msFromDate(ydocStat.mtime)
    const mdMs = msFromDate(mdStat.mtime)
    if (ydocMs === null || mdMs === null) return false
    // Strict > so synchronized writes (identical mtime) don't trigger
    // a needless rewrite that would change `.md`'s mtime and ripple
    // through the watcher.
    return ydocMs > mdMs
  } catch {
    // stat failures shouldn't block the migration — fall through to
    // "not fresh" so we don't corrupt a `.md` we couldn't compare.
    return false
  }
}

function msFromDate(d: Date | null | undefined): number | null {
  if (!d) return null
  const ms = d.getTime()
  return Number.isFinite(ms) ? ms : null
}

/** Load `.ydoc` binary → temp Y.Doc → PM root node → markdown. The
 * temp Y.Doc is destroyed regardless of success so the in-memory
 * snapshot doesn't outlive the function. Returns null when the
 * fragment has no body content worth saving. */
async function ydocToMarkdown(
  ydocRel: string,
  schema: ReturnType<NonNullable<ReturnType<typeof useEditorViewStore.getState>['parser']>>['type']['schema'],
  serializer: NonNullable<
    ReturnType<typeof useEditorViewStore.getState>['serializer']
  >,
): Promise<string | null> {
  const binary = await readVaultBinary(ydocRel)
  const ydoc = new Y.Doc()
  try {
    Y.applyUpdate(ydoc, binary)
    const fragment = ydoc.getXmlFragment('prosemirror')
    if (fragment.length === 0) return null
    const pmNode = yXmlFragmentToProseMirrorRootNode(fragment, schema)
    return serializer(pmNode)
  } finally {
    ydoc.destroy()
  }
}

async function markSentinel(): Promise<void> {
  try {
    await writeVaultFile(
      SENTINEL_REL,
      `Migration v2 complete at ${new Date().toISOString()}\n`,
    )
  } catch (err) {
    // A missing sentinel just means the migration runs again next
    // boot; with the work itself idempotent (.md mtime > .ydoc after
    // backfill, so subsequent runs skip) that's not catastrophic.
    console.warn('[migration v2] failed to write sentinel', err)
  }
}
