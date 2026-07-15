// Import the user's existing Claude Code setup (`~/.claude`) into a fresh vault.
//
// Responsibility split (see src-tauri/src/claude_import.rs):
//   • This module OWNS the decision — for each asset, whether to copy it —
//     using the same idempotency contract as the seeders (seedCommands /
//     seedAgents / seedSkills): copy ONLY when the target is missing and not
//     tombstoned. So import runs safely on every boot: it never overwrites the
//     user's edits and never resurrects something they deleted. Running BEFORE
//     the seeds (BootGate.seedWikiDefaults) makes an imported asset win over the
//     built-in default of the same name (the seed then finds it and skips).
//   • Rust OWNS the physical copy. Commands / agents are single `.md` files, so
//     `read_claude_code` returns their bodies and we write them via the vault
//     helpers. A skill is a DIRECTORY (SKILL.md + companion scripts/assets,
//     possibly binary), so we hand the whole folder to `copy_claude_skill`.
//
// Scope: commands, agents, skills. The global `~/.claude/CLAUDE.md`, settings,
// and MCP config are intentionally NOT imported.

import { invoke } from '@tauri-apps/api/core'
import { join } from '@tauri-apps/api/path'
import { readVaultFile, writeVaultFile, vaultFileExists } from '@/lib/vault'
import { getActiveVaultPath } from '@/state/settingsStore'
import { readTombstones } from '@/lib/assetTombstone'
import { COMMANDS_REL } from '@/lib/commandsLib'
import { AGENTS_REL } from '@/lib/agentsLib'
import { SKILLS_REL } from '@/lib/skillsLib'

/** One markdown asset read from `~/.claude` — mirrors the Rust `ImportedFile`. */
interface ImportedFile {
  name: string
  body: string
}

/** The manifest `read_claude_code` returns — mirrors the Rust `ClaudeCodeImport`.
 * `skills` is just the folder names; the folders are copied by `copy_claude_skill`. */
interface ClaudeCodeImport {
  commands: ImportedFile[]
  agents: ImportedFile[]
  skills: string[]
}

// One-time marker: import is a MIGRATION, not a live sync (matches Claude Code's
// own model — personal `~/.claude` assets are read from a single source, not
// re-copied per project). Once a vault has imported, we never import again, so a
// later Claude Code edit/add doesn't silently leak into an existing vault. The
// marker lives IN the vault so it travels with it: move the vault to another
// machine and it won't re-import from that machine's unrelated `~/.claude`.
//
// NOT a dotfile: the Tauri fs capability `$HOME/**` scope doesn't match
// dot-prefixed files, so a `.`-name would need explicit scope entries (as
// `.deleted.json` has). A plain name is covered by `$HOME/**` for read / write /
// rename, and `_system/` is already hidden from the file tree and watcher.
const IMPORTED_MARKER_REL = '_system/agent/claude-imported.json'

/** True once this vault has already run the Claude Code import. Uses
 * readVaultFile (existence via read) to stay on the read/write scopes the
 * marker path is covered by. */
async function hasImported(): Promise<boolean> {
  try {
    await readVaultFile(IMPORTED_MARKER_REL)
    return true
  } catch {
    return false
  }
}

/** Record that this vault has imported, so future boots skip it. */
async function markImported(): Promise<void> {
  await writeVaultFile(IMPORTED_MARKER_REL, '{"imported":true}\n')
}

/** Copy the user's Claude Code commands / agents / skills into the active vault,
 * ONCE per vault (see {@link IMPORTED_MARKER_REL}). Best-effort: a read failure
 * or a missing `~/.claude` imports nothing. Returns the number of assets written
 * (skips existing / tombstoned), so the caller can surface a one-line summary. */
export async function importClaudeCode(): Promise<number> {
  // One-time gate: if this vault already imported, do nothing — not even the
  // `~/.claude` read. This is what makes it a one-shot migration instead of a
  // per-boot sync.
  if (await hasImported()) return 0

  let manifest: ClaudeCodeImport
  try {
    manifest = await invoke<ClaudeCodeImport>('read_claude_code')
  } catch (err) {
    // Read failed → don't mark; retry on the next boot.
    console.warn('[claude-import] read failed', err)
    return 0
  }

  const vaultRoot = getActiveVaultPath()
  if (!vaultRoot) {
    // Nothing to import into — import only runs during a vault boot, so this
    // is defensive (a race where the active vault cleared mid-boot).
    console.warn('[claude-import] no active vault; skipping')
    return 0
  }

  const dead = await readTombstones()
  let written = 0

  // Copy a single-file asset only if the target is absent AND not user-deleted
  // — the same contract the seeders use, so import + seed compose cleanly.
  const copyFileIfNew = async (rel: string, body: string): Promise<void> => {
    if (dead.has(rel)) return
    if (await vaultFileExists(rel)) return
    await writeVaultFile(rel, body)
    written += 1
  }

  for (const c of manifest.commands) {
    await copyFileIfNew(`${COMMANDS_REL}/${c.name}.md`, c.body)
  }
  for (const a of manifest.agents) {
    await copyFileIfNew(`${AGENTS_REL}/${a.name}.md`, a.body)
  }

  // Skills are folders: gate on the SKILL.md path (matching how a skill delete
  // tombstones and how seedSkills checks existence), then let Rust copy the
  // whole directory — companion scripts / references / assets included.
  for (const name of manifest.skills) {
    const skillMd = `${SKILLS_REL}/${name}/SKILL.md`
    if (dead.has(skillMd)) continue
    if (await vaultFileExists(skillMd)) continue
    try {
      const destDir = await join(vaultRoot, SKILLS_REL, name)
      await invoke('copy_claude_skill', { name, destDir })
      written += 1
    } catch (err) {
      // One bad skill (permissions, unreadable companion file) shouldn't abort
      // the rest of the import.
      console.warn('[claude-import] skill copy failed', name, err)
    }
  }

  // Mark this vault as imported so future boots skip — but ONLY if `~/.claude`
  // actually had something. If it was empty (no Claude Code yet), leave the vault
  // unmarked so a user who installs Claude Code AFTER creating this vault still
  // gets a one-time import on a later boot. (`written` can be 0 with assets
  // present — e.g. all already existed — so gate on the manifest, not `written`.)
  const hadAssets =
    manifest.commands.length > 0 ||
    manifest.agents.length > 0 ||
    manifest.skills.length > 0
  if (hadAssets) await markImported()

  if (written > 0) console.log('[claude-import] imported', written, 'asset(s)')
  return written
}
