// The agent's schema (`CLAUDE.md`) is now APP-OWNED: it ships in the app
// bundle and is injected straight into the system prompt (see
// wikiService.readClaudeMd). We no longer seed a `CLAUDE.md` file into the
// vault — schema improvements reach every vault on the next build without
// touching the user's files.
//
// The one per-user slice that used to live in that file is the behaviour
// preferences. This module's remaining job is a one-shot, additive
// migration: if a legacy vault still has a seeded `CLAUDE.md`, lift any
// user-authored preference bullets out of its `## Preferences` section into
// `_system/preferences.md` so nothing the user set is lost. It NEVER deletes
// the old file (the user can remove the now-inert `CLAUDE.md` themselves).
//
// Vault selection is required. Without one we silently skip; the next boot
// retries once the user has picked a folder.

import { readVaultFile, vaultFileExists, writeVaultFile } from '@/lib/vault'
import { getActiveVaultPath } from '@/state/settingsStore'
import { splitFrontmatter } from '@/lib/frontmatter'
import { PREFERENCES_REL } from '@/state/wikiService'

const CLAUDE_MD_REL = 'CLAUDE.md'

/** One-shot migration for the bundled-schema model. Only acts when a legacy
 * `CLAUDE.md` exists AND `_system/preferences.md` doesn't yet — so it runs at
 * most once per vault and is a no-op for fresh vaults. */
export async function migrateClaudeMdPreferences(): Promise<void> {
  const vault = getActiveVaultPath()
  if (!vault) return
  try {
    if (await vaultFileExists(PREFERENCES_REL)) return
    if (!(await vaultFileExists(CLAUDE_MD_REL))) return
    const { body } = splitFrontmatter(await readVaultFile(CLAUDE_MD_REL))
    const bullets = extractPreferenceBullets(body)
    if (bullets.length === 0) return
    await writeVaultFile(PREFERENCES_REL, `${bullets.join('\n')}\n`)
    console.log(
      `[migrate] moved ${bullets.length} preference(s) from CLAUDE.md to ${PREFERENCES_REL}`,
    )
  } catch (err) {
    console.warn('[migrate] preference migration failed', err)
  }
}

/** Pull the user-authored bullet lines out of the `## Preferences` section.
 * The template body of that section is prose, so any `-`/`*` bullet under it
 * is something the user added. Stops at the next `## ` heading. */
function extractPreferenceBullets(markdown: string): string[] {
  const lines = markdown.split('\n')
  const bullets: string[] = []
  let inSection = false
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      inSection = /^##\s+Preferences\s*$/.test(line)
      continue
    }
    if (inSection && /^\s*[-*]\s+\S/.test(line)) bullets.push(line.trim())
  }
  return bullets
}
