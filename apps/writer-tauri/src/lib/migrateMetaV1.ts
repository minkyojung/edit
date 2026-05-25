// One-shot migration that lifts `createdAt` out of `Y.Map('meta')`
// and into the `.meta.json` sidecar.
//
// Why this exists:
//   Phase 5b of the Yjs-removal migration retires `useDocMeta`'s
//   Y.Map-backed metadata in favour of `.meta.json`. Most of what the
//   Y.Map held (`type`, `date`, `parentId`) is already path-derived
//   by `scanVault`, so only `createdAt` had no home outside the
//   Y.Map. This script walks every `.ydoc` in the vault, extracts the
//   `Y.Map('meta').createdAt` field, and merges it into the paired
//   `.meta.json` for any doc whose sidecar doesn't already carry one.
//
// Idempotent guard:
//   Sentinel file `.writer-meta-migrated` at the vault root. Present
//   → migration ran, no-op. Absent → walk + merge + drop the
//   sentinel. Deleting the sentinel re-runs the migration (useful if
//   a user manually edits a sidecar and we want to re-derive).
//
// Failure mode:
//   Each `.ydoc` is processed independently in a try/catch — a single
//   corrupt binary doesn't block the whole pass. We don't drop the
//   sentinel on a corrupt-binary catch either, since the failure is
//   permanent for that file; future boots would just retry the same
//   failing read.

import * as Y from 'yjs'
import {
  listVaultDir,
  readVaultBinary,
  readVaultFile,
  vaultFileExists,
  writeVaultFile,
} from '@/lib/vault'
import { getActiveVaultPath } from '@/state/settingsStore'
import type { DocMetaFile } from '@/lib/docPaths'

// See migrateYdocV2.ts for the rationale on avoiding a dot-prefixed
// sentinel filename (Tauri's `fs:scope` glob silently excludes
// dot-files, so `vaultFileExists` returns a permission error rather
// than a clean false).
const SENTINEL_REL = 'writer-meta-migration-v1.done'

/** Subdirectories that may host doc bundles. `threads/` is excluded
 * the same way it is in `migrateYdocV2` — chat thread JSON has never
 * been persisted as `.ydoc`. */
const WALK_ROOTS = ['wiki', 'daily', '_system'] as const

export async function migrateMetaV1(): Promise<void> {
  const vault = getActiveVaultPath()
  if (!vault) return

  if (await vaultFileExists(SENTINEL_REL)) return

  const ydocFiles = await collectYdocFiles()
  if (ydocFiles.length === 0) {
    await markSentinel()
    return
  }

  let migrated = 0
  let skipped = 0
  for (const ydocRel of ydocFiles) {
    const metaRel = ydocRel.replace(/\.ydoc$/, '.meta.json')
    try {
      // Sidecar already has createdAt → nothing to do for this doc.
      if (await vaultFileExists(metaRel)) {
        const raw = await readVaultFile(metaRel)
        const parsed = JSON.parse(raw) as Partial<DocMetaFile>
        if (typeof parsed.createdAt === 'string') {
          skipped += 1
          continue
        }
      }

      // Pull createdAt off the .ydoc's Y.Map('meta').
      const binary = await readVaultBinary(ydocRel)
      const ydoc = new Y.Doc()
      let createdAt: string | null = null
      try {
        Y.applyUpdate(ydoc, binary)
        const candidate = ydoc.getMap('meta').get('createdAt')
        if (typeof candidate === 'string') createdAt = candidate
      } finally {
        ydoc.destroy()
      }

      if (!createdAt) {
        skipped += 1
        continue
      }

      // Merge into (or create) the sidecar.
      let existing: Partial<DocMetaFile> = {}
      if (await vaultFileExists(metaRel)) {
        try {
          const raw = await readVaultFile(metaRel)
          existing = JSON.parse(raw) as Partial<DocMetaFile>
        } catch {
          // Corrupt sidecar — overwrite with the minimal shape below.
        }
      }
      const merged: DocMetaFile = {
        version: 1,
        slug: existing.slug ?? deriveSlugFromYdocRel(ydocRel),
        ...existing,
        createdAt,
      }
      await writeVaultFile(metaRel, JSON.stringify(merged, null, 2))
      migrated += 1
    } catch (err) {
      console.warn('[migration meta v1] failed for', ydocRel, err)
    }
  }

  await markSentinel()
  console.log(
    `[migration meta v1] migrated ${migrated} / skipped ${skipped} (of ${ydocFiles.length} .ydoc files)`,
  )
}

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
    if (!name.includes('.')) {
      await walkInto(childRel, out)
    }
  }
}

/** Fallback slug derivation for an orphan `.ydoc` whose `.meta.json`
 * has no `slug` field (or no `.meta.json` at all). Reads `<stem>.md`'s
 * sibling `<stem>.meta.json` if present — otherwise we can't recover
 * a real slug, so synthesise one from the filename so the JSON is at
 * least well-formed. `scanVault` will pick up the correct slug on the
 * next boot via `getOrAssignSlug`. */
function deriveSlugFromYdocRel(ydocRel: string): string {
  const filename = ydocRel.split('/').pop() ?? ydocRel
  return filename.replace(/\.ydoc$/, '')
}

async function markSentinel(): Promise<void> {
  try {
    await writeVaultFile(
      SENTINEL_REL,
      `Meta migration v1 complete at ${new Date().toISOString()}\n`,
    )
  } catch (err) {
    console.warn('[migration meta v1] failed to write sentinel', err)
  }
}
