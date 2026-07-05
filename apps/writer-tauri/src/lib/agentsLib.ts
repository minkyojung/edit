// Agents = editable AI "roles" (researcher, translator, proofreader, …) as
// markdown files under the agent plugin dir — `_system/agent/agents/<name>.md`,
// matching Claude Code's `.claude/agents/` shape: frontmatter (description,
// model, tools) + prompt body = an SDK `AgentDefinition`. Same location + loading
// as skills and commands, so scanVault catalogues each (editable in the editor)
// and the SDK plugins path can load them.
//
// Two uses of one file: (1) the user picks a role for a chat thread → its prompt
// becomes the main system prompt (agents.resolveAgent); (2) it's passed as an
// SDK subagent (options.agents) the main agent can delegate to. A missing file
// falls back to the built-in default, so behavior is unchanged until the user
// adds or edits one.

import {
  readVaultFile,
  writeVaultFile,
  vaultFileExists,
  listVaultDir,
} from '@/lib/vault'
import { splitFrontmatter } from '@/lib/frontmatter'
import { readTombstones } from '@/lib/assetTombstone'

/** Where agent role files live — under the agent plugin dir, next to
 * `_system/agent/skills` and `_system/agent/commands`. */
export const AGENTS_REL = '_system/agent/agents'

/** Load an agent's prompt body from `<AGENTS_REL>/<name>.md` (frontmatter
 * stripped). Falls back to `fallback` when the file is missing/unreadable/empty,
 * so an unknown role or a fresh vault behaves as the built-in default. */
export async function loadAgentPrompt(
  name: string,
  fallback: string,
): Promise<string> {
  try {
    const raw = await readVaultFile(`${AGENTS_REL}/${name}.md`)
    const body = splitFrontmatter(raw).body.trim()
    return body.length > 0 ? body : fallback
  } catch {
    return fallback
  }
}

/** A default role to seed. `model` is optional frontmatter (a role can run on a
 * different model, e.g. researcher → opus). */
export interface AgentSeed {
  name: string
  description: string
  body: string
  model?: string
}

/** Seed default role files into `<AGENTS_REL>/` if missing. Idempotent by file
 * existence (never overwrites the user's edits) — same contract as seedRoutines.
 * scanVault mints a slug into each on the next scan, so they become editable
 * notes. */
export async function seedAgents(seeds: AgentSeed[]): Promise<void> {
  // Skip anything the user has deleted, so a deleted default doesn't resurrect
  // on the next boot (seeding is otherwise idempotent-by-existence).
  const dead = await readTombstones()
  for (const seed of seeds) {
    const rel = `${AGENTS_REL}/${seed.name}.md`
    if (dead.has(rel)) continue
    if (await vaultFileExists(rel)) continue
    const fm = [
      `name: ${seed.name}`,
      `description: ${seed.description}`,
      ...(seed.model ? [`model: ${seed.model}`] : []),
    ].join('\n')
    const content = `---\n${fm}\n---\n\n${seed.body.trim()}\n`
    await writeVaultFile(rel, content)
    console.log('[seed agents] wrote default', rel)
  }
}

/** One role as the Agents page lists it (and the chat role picker offers it). */
export interface VaultAgent {
  /** Role id/name (frontmatter `name`, else the file stem). Also the thread
   * `agentId`. */
  name: string
  /** One-line "when to use this role" (frontmatter `description`). */
  description: string
  /** File name within `AGENTS_REL` (e.g. `researcher.md`). */
  fileName: string
  /** Catalog slug (minted by scanVault) so the file opens in the editor. '' when
   * not yet scanned. */
  slug: string
}

/** List every role file, name-sorted. Empty on a fresh vault or read error. */
export async function listAgents(): Promise<VaultAgent[]> {
  let entries: string[]
  try {
    entries = await listVaultDir(AGENTS_REL)
  } catch {
    return []
  }
  const out: VaultAgent[] = []
  for (const fn of entries) {
    if (!fn.endsWith('.md')) continue
    let name = fn.replace(/\.md$/, '')
    let description = ''
    let slug = ''
    try {
      const { data } = splitFrontmatter(await readVaultFile(`${AGENTS_REL}/${fn}`))
      name = (data.name || name).trim()
      description = (data.description || '').trim()
      slug = (data.slug || '').trim()
    } catch {
      // Unreadable file — still list it by filename.
    }
    out.push({ name, description, fileName: fn, slug })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
