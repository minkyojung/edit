// Read/manage the vault-local Agent Skills the chat agent creates via
// propose_skill. Skills live at `_system/agent/skills/<dir>/SKILL.md` and
// are catalogued as generic notes (scanVault mints a slug into each), so
// they open in the editor like any note. The Skills page reads the files
// directly to show name + description; opening/deletion use the slug/folder.

import { listVaultDir, readVaultFile, deleteVaultDir } from '@/lib/vault'
import { splitFrontmatter } from '@/lib/frontmatter'

const SKILLS_REL = '_system/agent/skills'

export interface VaultSkill {
  /** Folder name under the skills dir — the delete/identity key. */
  dir: string
  /** SKILL.md `name` frontmatter (falls back to the folder name). */
  name: string
  /** SKILL.md `description` — the when-to-use line. */
  description: string
  /** Catalog slug (minted into the SKILL.md frontmatter by scanVault) so the
   * file opens in the editor. '' when not yet scanned. */
  slug: string
}

/** List every skill in the vault. Returns [] when the skills dir doesn't
 * exist yet. Entries that aren't readable skill folders are skipped. */
export async function listSkills(): Promise<VaultSkill[]> {
  let entries: string[]
  try {
    entries = await listVaultDir(SKILLS_REL)
  } catch {
    return []
  }
  const skills: VaultSkill[] = []
  for (const dir of entries) {
    try {
      const raw = await readVaultFile(`${SKILLS_REL}/${dir}/SKILL.md`)
      const { data } = splitFrontmatter(raw)
      skills.push({
        dir,
        name: (data.name ?? dir).trim(),
        description: (data.description ?? '').trim(),
        slug: (data.slug ?? '').trim(),
      })
    } catch {
      // Not a skill folder (no SKILL.md) or unreadable — skip.
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

/** Delete a skill by its folder name. The next chat turn's dir scan stops
 * including it, so it drops out of the agent's context too. */
export async function deleteSkill(dir: string): Promise<void> {
  await deleteVaultDir(`${SKILLS_REL}/${dir}`)
}

/** Read a skill's current body (frontmatter stripped) by folder name.
 * Returns '' when the skill doesn't exist — used by the proposal tray to
 * diff an UPDATE against what's on disk. */
export async function readSkillBody(dir: string): Promise<string> {
  try {
    const raw = await readVaultFile(`${SKILLS_REL}/${dir}/SKILL.md`)
    return splitFrontmatter(raw).body
  } catch {
    return ''
  }
}
