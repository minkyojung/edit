// Read/manage the vault-local Agent Skills the chat agent creates via
// propose_skill. Skills live at `_system/agent/skills/<dir>/SKILL.md` and are
// catalogued as generic notes, so they open in the editor like any note. The
// Skills page reads the files directly to show name + description; opening and
// deletion go by folder, and the catalog slug is resolved from the PATH — see
// `skillDocSlug`.

import { listVaultDir, readVaultFile, writeVaultFile, vaultFileExists } from '@/lib/vault'
import { splitFrontmatter } from '@/lib/frontmatter'
import { readTombstones } from '@/lib/assetTombstone'
import { pathToKnownSlug } from '@/lib/docPaths'
import type { KnownDoc } from '@/state/docsStore'

export const SKILLS_REL = '_system/agent/skills'

/** Vault-relative path of a skill folder's SKILL.md. One spelling, because
 *  five places used to write it out and the constant is only half the string. */
export function skillMdPath(dir: string): string {
  return `${SKILLS_REL}/${dir}/SKILL.md`
}

/** This session's catalog slug for a skill folder, or null when the catalog has
 *  no note at that path.
 *
 *  Resolved from the PATH, never from the file. The slug is ephemeral —
 *  `scanVault.ts` calls it "never persisted, never written to the file", and
 *  `portableFrontmatterFields` lists `slug: undefined` so the flush strips it —
 *  so a `slug:` still sitting in a SKILL.md is a leftover from an earlier run
 *  that this session's catalog has never heard of. Reading it, which is what
 *  this module used to do, produced a slug that opened nothing.
 *
 *  Takes the catalog as an argument rather than reaching into the store, so
 *  this file stays store-free and the function stays pure. Same shape as
 *  `ToolPart`'s path→slug resolution for chat tool results. */
export function skillDocSlug(dir: string, knownDocs: readonly KnownDoc[]): string | null {
  return pathToKnownSlug(skillMdPath(dir), knownDocs)
}

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
 * resurrect — the same contract as `seedCommands` / `seedAgents`. */
export async function seedSkills(seeds: SkillSeed[]): Promise<void> {
  const dead = await readTombstones()
  for (const seed of seeds) {
    const rel = skillMdPath(seed.name)
    if (dead.has(rel)) continue
    if (await vaultFileExists(rel)) continue
    const content = `---\nname: ${seed.name}\ndescription: ${seed.description}\n---\n\n${seed.body.trim()}\n`
    await writeVaultFile(rel, content)
    console.log('[seed skills] wrote default', rel)
  }
}

export interface VaultSkill {
  /** Folder name under the skills dir — the delete/identity key, and what
   * `skillDocSlug` resolves an openable slug from. */
  dir: string
  /** SKILL.md `name` frontmatter (falls back to the folder name). */
  name: string
  /** SKILL.md `description` — the when-to-use line. */
  description: string
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
      const raw = await readVaultFile(skillMdPath(dir))
      const { data } = splitFrontmatter(raw)
      skills.push({
        dir,
        name: (data.name ?? dir).trim(),
        description: (data.description ?? '').trim(),
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
    const raw = await readVaultFile(skillMdPath(dir))
    return splitFrontmatter(raw).body
  } catch {
    return ''
  }
}
