// One-shot seed for the vault's `CLAUDE.md` — the Karpathy /
// Claude Code schema document. BootGate calls this once per boot;
// the function is a no-op when the file already exists, so users
// who have customised their CLAUDE.md never see it overwritten.
//
// Idempotency is by file existence, not a sentinel marker. That
// matches the contract `seedClaudeMd` advertises (default seeds a
// fresh vault; user owns it from there) and avoids polluting the
// vault root with another `.done` file.
//
// Vault selection is required. Without one we silently skip; the
// next boot retries once the user has picked a folder.

import { invoke } from '@tauri-apps/api/core'
import { vaultFileExists, writeVaultFile } from '@/lib/vault'
import { getActiveVaultPath } from '@/state/settingsStore'
import { todayLocalDate } from '@/hooks/useDocMeta'
import { DEFAULT_CLAUDE_MD } from '@/agent/defaults'

const CLAUDE_MD_REL = 'CLAUDE.md'
const WELCOME_REL = 'Welcome.md'

export async function seedClaudeMd(): Promise<void> {
  const vault = getActiveVaultPath()
  if (!vault) return
  if (await vaultFileExists(CLAUDE_MD_REL)) return
  await writeVaultFile(CLAUDE_MD_REL, DEFAULT_CLAUDE_MD)
  console.log('[seed CLAUDE.md] wrote default schema to vault root')
}

/** A short, friendly starter note so a brand-new vault opens on real content
 * instead of a blank editor — it demonstrates Markdown, links, and the AI, and
 * says it's yours to delete.
 *
 * "Brand-new" is detected by the ABSENCE of `CLAUDE.md`: seedWikiDefaults seeds
 * CLAUDE.md on first boot, so a vault without it has never been opened. This
 * MUST run BEFORE seedClaudeMd(), or the check always fails. Idempotent, and
 * scoped to fresh vaults, so an existing vault (or one where the user deleted
 * Welcome.md) is never touched. */
export async function seedWelcomeNote(): Promise<void> {
  const vault = getActiveVaultPath()
  if (!vault) return
  // Only a brand-new vault (no CLAUDE.md yet) gets a welcome note.
  if (await vaultFileExists(CLAUDE_MD_REL)) return
  if (await vaultFileExists(WELCOME_REL)) return
  await writeVaultFile(WELCOME_REL, WELCOME_NOTE)
  console.log('[seed Welcome.md] wrote starter note to fresh vault')
}

/** Seed today's daily note into a brand-new vault with a short, personal
 * welcome, so the timeline opens on "your day already started" instead of
 * an empty axis. Same freshness gate as seedWelcomeNote (CLAUDE.md absent
 * = never-opened vault) — so it MUST run BEFORE seedClaudeMd. Idempotent:
 * skips if today's daily already exists. The daily is recognized on the
 * next scan purely by its `daily/<date>.md` path (no sidecar needed). */
export async function seedFirstDaily(): Promise<void> {
  const vault = getActiveVaultPath()
  if (!vault) return
  if (await vaultFileExists(CLAUDE_MD_REL)) return // not a fresh vault
  const rel = `daily/${todayLocalDate()}.md`
  if (await vaultFileExists(rel)) return
  await writeVaultFile(rel, firstDailyNote(await firstName()))
  console.log('[seed daily] wrote welcome daily to fresh vault')
}

/** The signed-in Google display name's first token, or null when there's
 * no account (the user skipped sign-in). Best-effort — a lookup failure
 * just drops the personalization. */
async function firstName(): Promise<string | null> {
  try {
    const acc = await invoke<{ name: string | null }>('get_google_account')
    const full = acc?.name?.trim()
    return full ? full.split(/\s+/)[0] : null
  } catch {
    return null
  }
}

function firstDailyNote(name: string | null): string {
  const hello = name ? `Welcome, ${name}.` : 'Welcome.'
  // Single newlines (not blank-line paragraph breaks): the editor draws a
  // blank line as a real, cursor-able empty row, which reads as a stray
  // line break in a short welcome. `\n` stacks the lines tightly instead.
  return `${hello} Today is where it begins.
This is your **daily note**. From now on, whenever you write something or save an article, it lands in the note for that day. No setup. Each day fills itself in as you go.
Start below, or open the chat and ask the AI for a hand.
`
}

const WELCOME_NOTE = `# Welcome to Octave

This is a plain Markdown note — everything you write lives as a file in your
folder, yours to keep, move, or back up however you like.

A few things to try:

- **Write freely.** Clear this note and start your own, or keep it as a scratchpad.
- **Link your notes** with \`[[double brackets]]\` — they connect ideas into a web.
- **Work with the AI.** Open the chat panel and ask it to summarize, rewrite, or
  tidy your notes. It edits right here, alongside you.

When you connect your Claude account, the AI can read and edit the notes in this
folder — and only this folder. It can't reach your secrets or send anything out.

Delete this note whenever you're ready.
`
