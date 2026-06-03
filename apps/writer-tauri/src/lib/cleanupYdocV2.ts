// Phase 7 of the Yjs-removal migration: delete the `.ydoc` files
// the previous architecture wrote alongside every `.md`. The Yjs
// content has been retired — Phase 2 back-filled the `.md` body
// where the `.ydoc` was fresher, Phase 5b lifted `createdAt` out of
// `Y.Map('meta')` into `.meta.json`, and Phase 5c removed the
// in-memory Y.Doc. Nothing in the app reads `.ydoc` anymore;
// keeping the binaries around would only confuse Finder + bloat
// git diffs.
//
// Idempotent + sentinel-gated: a single `cleanupYdocV2.done`
// marker at the vault root short-circuits the walk on every
// subsequent boot. The cleanup itself is best-effort — a per-file
// delete failure (permission, file already gone, ...) is logged
// and skipped; the sentinel still lands so a permanently-stuck
// file doesn't cause this routine to walk the vault forever.
//
// No Yjs dependency — pure filesystem ops. This is the last
// migration in the Yjs-removal series; once it runs, removing
// `yjs` / `y-prosemirror` / `@milkdown/plugin-collab` from
// `package.json` is safe.

import { deleteVaultFile, listVaultDir, vaultFileExists, writeVaultFile } from '@/lib/vault'
import { getActiveVaultPath } from '@/state/settingsStore'

// Plain filename (no dot prefix) so Tauri's `fs:scope` glob — which
// uses `**` and silently excludes dot-prefixed entries — actually
// matches it. Mirrors the convention `migrateYdocV2` uses for its
// sentinel. BootGate adds this name to `.gitignore` so it doesn't
// pollute the user's commit history.
const SENTINEL_REL = 'writer-cleanup-ydoc.done'

/** Vault subdirectories that may contain `.ydoc` files. `threads/`
 * is intentionally excluded — chat thread JSON was never persisted
 * as Yjs binaries, so a walk through it would be wasted I/O. Same
 * roots {@link migrateYdocV2} uses; if a future doc kind needs
 * cleanup it has to opt in here. */
const WALK_ROOTS = ['wiki', 'daily', '_system'] as const

/** Run the cleanup once. Safe to call on every boot — the sentinel
 * makes repeated calls a no-op. Vault selection is required; without
 * one we silently skip (BootGate runs the picker before calling us,
 * so the only "no vault" path is the user cancelling the picker). */
export async function cleanupYdocV2(): Promise<void> {
  const vault = getActiveVaultPath()
  if (!vault) return

  if (await vaultFileExists(SENTINEL_REL)) return

  const ydocFiles = await collectYdocFiles()
  if (ydocFiles.length === 0) {
    await markSentinel()
    return
  }

  let deleted = 0
  let failed = 0
  for (const rel of ydocFiles) {
    try {
      await deleteVaultFile(rel)
      deleted += 1
    } catch (err) {
      console.warn('[cleanup ydoc] delete failed for', rel, err)
      failed += 1
    }
  }

  await markSentinel()
  console.log(
    `[cleanup ydoc] deleted ${deleted} / failed ${failed} (of ${ydocFiles.length} .ydoc files)`,
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
    // No extension → assume directory. Same heuristic
    // `migrateYdocV2` uses: extensionless names are folders in
    // vault layout (`.md` / `.ydoc` / `.meta.json` are the only
    // content extensions).
    if (!name.includes('.')) {
      await walkInto(childRel, out)
    }
  }
}

async function markSentinel(): Promise<void> {
  try {
    await writeVaultFile(SENTINEL_REL, new Date().toISOString() + '\n')
  } catch (err) {
    console.warn('[cleanup ydoc] sentinel write failed', err)
  }
}
