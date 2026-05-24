// Kind for slash commands that rewrite a passage in the document body
// (`/shorten`, `/expand`, `/polish`). The model edits via Claude's
// built-in Edit tool (Phase 3.1.5 retired the host-bridged
// `edit_document` MCP relay); the vaultWatcher → noteActivity chain
// detects the disk change and the chat engine commits a single
// "ai-edit: chat reply ..." entry at turn end. Review happens via
// git Undo in the Review panel.

import type { CommandKind } from '../types'

export const documentEditKind: CommandKind = {
  id: 'document-edit',
  // No relay tools — built-in Edit covers the rewrite path.
  relayTools: [],
}
