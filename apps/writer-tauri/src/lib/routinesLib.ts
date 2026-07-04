// Routines = the agent's task "brains" (inbox organize, daily ingest, chat→wiki)
// as USER-EDITABLE files, following the Claude Code convention: markdown files
// under `.claude/commands/`. Today our own code reads them (loadRoutinePrompt)
// and injects the body as the intake system prompt; the canonical location
// means that when the SDK's native `settingSources: ['project']` loading is
// turned on later, these files are already where the SDK expects them — no move
// needed.
//
// Mirrors `skillsLib` (vault-local markdown that defines agent behavior) and
// `seedClaudeMd` (ship a good default, user owns it from there). A missing /
// empty file falls back to the hardcoded constant, so behavior is unchanged
// until the user edits the file.

import {
  readVaultFile,
  writeVaultFile,
  vaultFileExists,
  listVaultDir,
} from '@/lib/vault'
import { splitFrontmatter } from '@/lib/frontmatter'

/** Claude Code's slash-command directory, vault-relative. */
export const COMMANDS_REL = '.claude/commands'

/** Load a routine's prompt body from `.claude/commands/<name>.md`, stripping any
 * YAML frontmatter. Falls back to `fallback` (the hardcoded constant) when the
 * file is missing, unreadable, or its body is empty — so a fresh vault, or one
 * where the user deleted the file, behaves exactly as before. */
export async function loadRoutinePrompt(
  name: string,
  fallback: string,
): Promise<string> {
  try {
    const raw = await readVaultFile(`${COMMANDS_REL}/${name}.md`)
    const body = splitFrontmatter(raw).body.trim()
    return body.length > 0 ? body : fallback
  } catch {
    return fallback
  }
}

/** One default routine to seed: the command file name, a one-line description
 * (frontmatter, for future UI discovery), and the body (the current hardcoded
 * prompt). */
export interface RoutineSeed {
  name: string
  description: string
  body: string
}

/** Seed default routine files into `.claude/commands/` if missing. Idempotent
 * by file existence (never overwrites the user's edits) — the same contract as
 * `seedClaudeMd`. Called once at boot. */
export async function seedRoutines(seeds: RoutineSeed[]): Promise<void> {
  for (const seed of seeds) {
    const rel = `${COMMANDS_REL}/${seed.name}.md`
    if (await vaultFileExists(rel)) continue
    const content = `---\nname: ${seed.name}\ndescription: ${seed.description}\n---\n\n${seed.body.trim()}\n`
    await writeVaultFile(rel, content)
    console.log('[seed routines] wrote default', rel)
  }
}

/** One routine as the Routines page lists it. */
export interface VaultRoutine {
  /** Command name (frontmatter `name`, else the file stem). */
  name: string
  /** One-line "what this does" (frontmatter `description`). */
  description: string
  /** File name within `.claude/commands/` (e.g. `organize.md`). */
  fileName: string
}

/** List the routine command files under `.claude/commands/`, newest-name first.
 * Empty on a fresh vault or read error. */
export async function listRoutines(): Promise<VaultRoutine[]> {
  try {
    const entries = await listVaultDir(COMMANDS_REL)
    const out: VaultRoutine[] = []
    for (const fn of entries) {
      if (!fn.endsWith('.md')) continue
      let name = fn.replace(/\.md$/, '')
      let description = ''
      try {
        const { data } = splitFrontmatter(await readVaultFile(`${COMMANDS_REL}/${fn}`))
        name = data.name || name
        description = data.description || ''
      } catch {
        // Unreadable file — still list it by filename.
      }
      out.push({ name, description, fileName: fn })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

/** Read a routine's editable prompt body (frontmatter stripped). */
export async function readRoutineBody(fileName: string): Promise<string> {
  const raw = await readVaultFile(`${COMMANDS_REL}/${fileName}`)
  return splitFrontmatter(raw).body.trim()
}

/** Write a routine's prompt body back, preserving its name/description
 * frontmatter. Takes effect on the next run (loadRoutinePrompt reads live). */
export async function saveRoutineBody(
  fileName: string,
  description: string,
  body: string,
): Promise<void> {
  const name = fileName.replace(/\.md$/, '')
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`
  await writeVaultFile(`${COMMANDS_REL}/${fileName}`, content)
}
