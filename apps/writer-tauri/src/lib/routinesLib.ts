// Routines = the agent's editable task "brains" (inbox organize, daily ingest,
// chat→wiki) as markdown files. They live under the SAME agent plugin dir as
// skills — `_system/agent/commands/<name>.md` — which buys three things:
//   • the SDK can load them via the same `plugins` path it already uses for
//     skills (`_system/agent`) — no `.claude/` settingSources flip needed;
//   • scanVault catalogues them as generic notes (mints a slug into the
//     frontmatter), so they open in the real editor and auto-save like any note;
//   • fileTree hides `_`-prefixed paths, so they don't clutter the notes tree.
//
// At runtime loadRoutinePrompt reads the body and feeds it as the intake system
// prompt; a missing/empty file falls back to the hardcoded constant, so behavior
// is unchanged until the user edits the file.

import {
  readVaultFile,
  writeVaultFile,
  vaultFileExists,
  listVaultDir,
} from '@/lib/vault'
import { splitFrontmatter } from '@/lib/frontmatter'

/** Where routine command files live — under the agent plugin dir, next to
 * `_system/agent/skills`. */
export const COMMANDS_REL = '_system/agent/commands'

/** Load a routine's prompt body from `<COMMANDS_REL>/<name>.md`, stripping any
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
 * (frontmatter, for the Routines list), and the body (the current hardcoded
 * prompt). */
export interface RoutineSeed {
  name: string
  description: string
  body: string
}

/** Seed default routine files into `<COMMANDS_REL>/` if missing. Idempotent by
 * file existence (never overwrites the user's edits) — the same contract as
 * `seedClaudeMd`. Called once at boot. scanVault mints a slug into each on the
 * next scan, so they become editable notes. */
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
  /** File name within `COMMANDS_REL` (e.g. `organize.md`). */
  fileName: string
  /** Catalog slug (minted into the frontmatter by scanVault) so the file opens
   * in the editor. '' when not yet scanned. */
  slug: string
}

/** List the routine command files, name-sorted. Empty on a fresh vault or read
 * error. */
export async function listRoutines(): Promise<VaultRoutine[]> {
  let entries: string[]
  try {
    entries = await listVaultDir(COMMANDS_REL)
  } catch {
    return []
  }
  const out: VaultRoutine[] = []
  for (const fn of entries) {
    if (!fn.endsWith('.md')) continue
    let name = fn.replace(/\.md$/, '')
    let description = ''
    let slug = ''
    try {
      const { data } = splitFrontmatter(await readVaultFile(`${COMMANDS_REL}/${fn}`))
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
