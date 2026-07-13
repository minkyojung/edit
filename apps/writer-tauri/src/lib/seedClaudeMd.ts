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
// A fresh vault gets ONLY this schema plus the `_system` scaffolding —
// no starter content notes are forced. A first-run welcome now belongs
// to onboarding, where empty-vs-imported is actually known; that keeps
// an imported directory clean instead of dropping a Welcome / daily note
// into someone's existing folder.
//
// Vault selection is required. Without one we silently skip; the
// next boot retries once the user has picked a folder.

import { vaultFileExists, writeVaultFile } from '@/lib/vault'
import { getActiveVaultPath } from '@/state/settingsStore'
import { DEFAULT_CLAUDE_MD } from '@/agent/defaults'

const CLAUDE_MD_REL = 'CLAUDE.md'

export async function seedClaudeMd(): Promise<void> {
  const vault = getActiveVaultPath()
  if (!vault) return
  if (await vaultFileExists(CLAUDE_MD_REL)) return
  await writeVaultFile(CLAUDE_MD_REL, DEFAULT_CLAUDE_MD)
  console.log('[seed CLAUDE.md] wrote default schema to vault root')
}
