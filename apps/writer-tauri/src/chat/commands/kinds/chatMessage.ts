// Default kind: free-form text response, rendered as a normal assistant
// turn in the chat panel. No relay tools — the model just writes prose.
//
// User-defined .md files that omit `kind` fall back to this one, so it
// also acts as the safe-by-default option.

import type { CommandKind } from '../types'

export const chatMessageKind: CommandKind = {
  id: 'chat-message',
  relayTools: [],
}
