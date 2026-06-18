// Conventions-merge migration.
//
// The user-editable wiki conventions used to live in their own page
// (`_system/conventions.md`, type `system:conventions`) and were injected
// as a separate system-prompt block. They're really vault-maintenance rules
// — the same category as CLAUDE.md — so we folded them into CLAUDE.md's
// `## Conventions` section and dropped the separate surface.
//
// Fresh vaults get the Conventions section from the seed (DEFAULT_CLAUDE_MD
// carries it). EXISTING vaults, though, may hold a user-customised
// conventions page. This routine copies that content into the vault's
// CLAUDE.md so nothing the user wrote is lost, then deletes the old page
// (+ its identity sidecar) so it stops surfacing as an orphan system doc.
//
// Copy FIRST, delete after — content is preserved before the source goes
// away. Sentinel-gated + idempotent: a single `writer-conventions-merge.done`
// marker short-circuits every subsequent boot, so a write-ok / delete-failed
// hiccup can't double-append on the next run. Mirrors flattenVaultV1's shape.
//
// The retired working-memory page (`_system/working.md`) is intentionally
// left untouched: there is no longer a memory surface to merge it into, and
// deleting it would discard user content. It simply stops being read — the
// hidden `_system/` file is harmless and the user can remove it if they want.

import {
  deleteVaultFile,
  readVaultFile,
  vaultFileExists,
  writeVaultFile,
} from '@/lib/vault'
import { splitFrontmatter } from '@/lib/frontmatter'
import { getActiveVaultPath } from '@/state/settingsStore'

const SENTINEL_REL = 'writer-conventions-merge.done'
const CLAUDE_MD = 'CLAUDE.md'
const OLD_CONVENTIONS = '_system/conventions.md'

/** Run the conventions merge once. Safe to call on every boot — the sentinel
 * makes repeated calls a no-op. Requires a selected vault. */
export async function migrateConventionsIntoClaudeMdV1(): Promise<void> {
  const vault = getActiveVaultPath()
  if (!vault) return
  if (await vaultFileExists(SENTINEL_REL)) return

  if (await vaultFileExists(OLD_CONVENTIONS)) {
    try {
      const body = splitFrontmatter(await readVaultFile(OLD_CONVENTIONS)).body.trim()
      if (body) {
        const existing = (await vaultFileExists(CLAUDE_MD))
          ? await readVaultFile(CLAUDE_MD)
          : ''
        await writeVaultFile(
          CLAUDE_MD,
          `${existing.trimEnd()}\n\n## Conventions (migrated)\n\n${body}\n`,
        )
      }
      await deleteVaultFile(OLD_CONVENTIONS)
      await deleteVaultFile(OLD_CONVENTIONS.replace(/\.md$/, '.meta.json'))
      console.log('[migrate conventions] conventions → CLAUDE.md')
    } catch (err) {
      console.warn('[migrate conventions] migration failed', err)
    }
  }

  try {
    await writeVaultFile(SENTINEL_REL, new Date().toISOString())
  } catch (err) {
    console.warn('[migrate conventions] sentinel write failed', err)
  }
}
