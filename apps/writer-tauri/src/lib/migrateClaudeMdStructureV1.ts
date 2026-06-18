// CLAUDE.md structure upgrade for existing vaults.
//
// The new CLAUDE.md shape (a `## Preferences` section for behaviour rules;
// a vault layout that no longer lists the retired `_system/conventions.md`)
// only reaches FRESH vaults through the seed. A vault created before these
// changes keeps its old CLAUDE.md, which causes two real failures observed
// in testing:
//
//   1. No `## Preferences` section → when the user says "always write my
//      reports formally, remember that", the agent routes the preference to
//      CLAUDE.md (correct) but has no heading to anchor the edit to, so the
//      propose_edit is silently dropped and nothing is saved.
//   2. The layout still lists `conventions.md` → the agent reads a file the
//      conventions-merge migration already deleted, wasting a tool call.
//
// This runs once per vault, after the CLAUDE.md seed and before bootstrap,
// and patches an EXISTING CLAUDE.md in place — surgically, so any edits the
// user made to their own CLAUDE.md survive:
//   - insert PREFERENCES_SECTION (the exact block the seed uses) before
//     `## Vault layout`, only when no `## Preferences` heading exists;
//   - drop the stale `conventions.md` layout line.
//
// Sentinel-gated + idempotent. Mirrors the other boot migrations' shape.

import { readVaultFile, vaultFileExists, writeVaultFile } from '@/lib/vault'
import { getActiveVaultPath } from '@/state/settingsStore'
import { PREFERENCES_SECTION } from '@/lib/defaultClaudeMd'

const SENTINEL_REL = 'writer-claudemd-structure-v1.done'
const CLAUDE_MD = 'CLAUDE.md'

export async function migrateClaudeMdStructureV1(): Promise<void> {
  const vault = getActiveVaultPath()
  if (!vault) return
  if (await vaultFileExists(SENTINEL_REL)) return
  if (!(await vaultFileExists(CLAUDE_MD))) return

  try {
    const original = await readVaultFile(CLAUDE_MD)
    let next = original

    // 1. Add the Preferences section if it's missing. Anchor before the
    //    Vault layout heading to match the seed's placement. If a
    //    heavily-customised CLAUDE.md has no such heading, skip the insert
    //    rather than guess a location.
    if (!/^## Preferences\s*$/m.test(next) && next.includes('## Vault layout')) {
      next = next.replace(
        '## Vault layout',
        `${PREFERENCES_SECTION}\n\n## Vault layout`,
      )
    }

    // 2. Drop the stale layout line for the retired conventions page.
    next = next.replace(/^[ \t]*conventions\.md[ \t]+—.*\n/m, '')

    if (next !== original) {
      await writeVaultFile(CLAUDE_MD, next)
      console.log('[migrate CLAUDE.md] upgraded structure (preferences + layout)')
    }
  } catch (err) {
    console.warn('[migrate CLAUDE.md] structure upgrade failed', err)
  }

  try {
    await writeVaultFile(SENTINEL_REL, new Date().toISOString())
  } catch (err) {
    console.warn('[migrate CLAUDE.md] sentinel write failed', err)
  }
}
