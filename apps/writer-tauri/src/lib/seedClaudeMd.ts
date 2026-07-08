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

import { vaultFileExists, writeVaultFile } from '@/lib/vault'
import { getActiveVaultPath } from '@/state/settingsStore'
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
