// Vault commands (`_system/agent/commands/*.md`) surfaced to the chat slash
// palette. These are the SDK-native commands — organize / daily-ingest /
// chat-to-wiki and any the user adds — invoked by sending `/<name> <args>` to
// the SDK, which expands the plugin command. They are now the ONLY kind of
// slash command; the client-side engine that used to run bundled editor
// actions (/proofread, /polish, …) has been removed.
//
// The list is loaded once the vault is ready and refreshed when the command
// files change. Both PromptInput (palette) and ChatPanel (slash dispatch) read
// from here, so the two agree on which slash names are valid vault commands.

import { create } from 'zustand'
import { listCommands } from '@/lib/commandsLib'

/** A command as the composer needs it. Vault commands are the only kind there
 * is, and they execute natively — the host just sends `/<name> <args>` and the
 * SDK expands the plugin command — so the palette only ever needs something to
 * show. The type lives here, next to the only thing that produces it.
 *
 * (It used to be `LoadedCommand` from the client-side `chat/commands` engine,
 * carrying `kind` / `scope` / `body` / `source` fields that vault commands
 * filled with inert placeholders. That engine is gone.) */
export interface VaultCommand {
  /** Slash name, no leading `/`. */
  name: string
  /** Shown next to the name in the palette. */
  description: string
}

/** Commands that exist in the vault but are NOT offered in the chat composer.
 * Currently none — kept as the hook for commands that should run only via a
 * background handoff rather than a user-typed `/command`. */
const COMPOSER_HIDDEN = new Set<string>()

interface VaultCommandsStore {
  commands: VaultCommand[]
  /** Reload the command list from the vault. Best-effort — a read error just
   * leaves the previous list in place. */
  refresh: () => Promise<void>
  /** Look up a vault command by slash name (no leading `/`). */
  get: (name: string) => VaultCommand | undefined
}

export const useVaultCommands = create<VaultCommandsStore>()((set, getState) => ({
  commands: [],
  refresh: async () => {
    try {
      const cmds = await listCommands()
      set({
        commands: cmds
          .filter((r) => !COMPOSER_HIDDEN.has(r.name))
          .map((r) => ({ name: r.name, description: r.description })),
      })
    } catch {
      // Keep the existing list on a read failure.
    }
  },
  get: (name) => getState().commands.find((c) => c.name === name),
}))
