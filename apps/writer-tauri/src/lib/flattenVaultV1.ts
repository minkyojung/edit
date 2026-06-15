// Flat-vault migration: delete the legacy `daily/` folder.
//
// The vault used to model journaling as a daily time-spine: a
// `daily/<date>.md` per day plus nested `daily/<date>/<title>.md`
// "writing" notes. That model was retired — the vault is now a plain
// Obsidian-style flat tree, and a new note is just a file under
// `inbox/`. The old daily/writing files carry no metadata we still
// read (a note's date lives in its `.md` frontmatter `createdAt`), so
// we remove the whole `daily/` subtree once.
//
// Idempotent + sentinel-gated: a single `writer-flatten-vault.done`
// marker at the vault root short-circuits the delete on every
// subsequent boot. Best-effort — a failed delete is logged and the
// sentinel still lands so a stuck folder doesn't make this routine
// run forever. Mirrors cleanupYdocV2's shape exactly.

import { deleteVaultDir, vaultFileExists, writeVaultFile } from '@/lib/vault'
import { getActiveVaultPath } from '@/state/settingsStore'

// Plain filename (no dot prefix) so Tauri's `fs:scope` glob matches
// it — same convention cleanupYdocV2's sentinel uses.
const SENTINEL_REL = 'writer-flatten-vault.done'

/** Run the daily-folder cleanup once. Safe to call on every boot — the
 * sentinel makes repeated calls a no-op. Requires a selected vault;
 * without one we silently skip (BootGate runs the picker first). */
export async function flattenVaultV1(): Promise<void> {
  const vault = getActiveVaultPath()
  if (!vault) return

  if (await vaultFileExists(SENTINEL_REL)) return

  try {
    await deleteVaultDir('daily')
    console.log('[flatten vault] removed legacy daily/ folder')
  } catch (err) {
    console.warn('[flatten vault] daily/ delete failed', err)
  }

  await markSentinel()
}

async function markSentinel(): Promise<void> {
  try {
    await writeVaultFile(SENTINEL_REL, new Date().toISOString() + '\n')
  } catch (err) {
    console.warn('[flatten vault] sentinel write failed', err)
  }
}
