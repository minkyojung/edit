// Read/manage the vault-local Agent Skills the chat agent creates via
// propose_skill. Skills live at `_system/agent/skills/<dir>/SKILL.md` and
// are catalogued as generic notes (scanVault mints a slug into each), so
// they open in the editor like any note. The Skills page reads the files
// directly to show name + description; opening/deletion use the slug/folder.

import { listVaultDir, readVaultFile, writeVaultFile, vaultFileExists } from '@/lib/vault'
import { splitFrontmatter } from '@/lib/frontmatter'
import { readTombstones } from '@/lib/assetTombstone'

export const SKILLS_REL = '_system/agent/skills'

/** One default skill to seed: the folder name, a one-line `description` (the
 * when-to-use trigger that surfaces in the agent's context), and the SKILL.md
 * body (the procedure). */
export interface SkillSeed {
  name: string
  description: string
  body: string
}

/** Seed default skills into `<SKILLS_REL>/<name>/SKILL.md` if missing.
 * Idempotent by file existence (never overwrites the user's edits) and skips
 * anything the user deleted (tombstoned), so a removed default doesn't
 * resurrect — the same contract as `seedRoutines` / `seedAgents`. */
export async function seedSkills(seeds: SkillSeed[]): Promise<void> {
  const dead = await readTombstones()
  for (const seed of seeds) {
    const rel = `${SKILLS_REL}/${seed.name}/SKILL.md`
    if (dead.has(rel)) continue
    if (await vaultFileExists(rel)) continue
    const content = `---\nname: ${seed.name}\ndescription: ${seed.description}\n---\n\n${seed.body.trim()}\n`
    await writeVaultFile(rel, content)
    console.log('[seed skills] wrote default', rel)
  }
}

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
