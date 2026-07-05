// Vault routine commands (`_system/agent/commands/*.md`) surfaced to the chat
// slash palette. These are the SDK-native commands — organize / daily-ingest /
// chat-to-wiki and any the user adds — invoked by sending `/<name> <args>` to
// the SDK for expansion (NOT the client-side `commands/builtin` engine).
//
// The list is loaded once the vault is ready and refreshed when the routine
// files change. Both PromptInput (palette) and ChatPanel (slash dispatch) read
// from here, so the two agree on which slash names are valid vault commands.

import { create } from 'zustand'
import { listRoutines } from '@/lib/routinesLib'
import type { LoadedCommand } from '@/chat/commands'

/** Routine commands that exist in the vault but are NOT offered in the chat
 * composer. `chat-to-wiki` operates on chat content (fired by the background
 * handoff), not a note the user is looking at, so a manual `/chat-to-wiki` has
 * nothing to act on — the ambient "proactive memory" behavior covers that job. */
const COMPOSER_HIDDEN = new Set(['chat-to-wiki'])

/** Adapt a vault routine into a palette command. `kind` / `scope` / `body` are
 * unused for vault commands (they run natively via the SDK), so they carry
 * inert placeholders; `source: 'vault'` is what routes execution. */
function toCommand(name: string, description: string): LoadedCommand {
  return {
    name,
    description,
    source: 'vault',
    kind: 'chat-message',
    scope: 'none',
    body: '',
  }
}

interface VaultCommandsStore {
  commands: LoadedCommand[]
  /** Reload the routine list from the vault. Best-effort — a read error just
   * leaves the previous list in place. */
  refresh: () => Promise<void>
  /** Look up a vault command by slash name (no leading `/`). */
  get: (name: string) => LoadedCommand | undefined
}

export const useVaultCommands = create<VaultCommandsStore>()((set, getState) => ({
  commands: [],
  refresh: async () => {
    try {
      const routines = await listRoutines()
      set({ commands: routines.map((r) => toCommand(r.name, r.description)) })
    } catch {
      // Keep the existing list on a read failure.
    }
  },
  get: (name) => getState().commands.find((c) => c.name === name),
}))
