// Kind for /review and any future "scan the document and apply
// every fix" commands. The model edits the doc with Claude's
// built-in Edit tool (Phase 3.1.5 retired the host-bridged
// `edit_document` MCP relay); ChatPanel still post-processes the
// run by replacing the assistant's text with a "Found N issues"
// summary so the chat surface stays uncluttered, and the user
// reviews the actual changes via the git Review panel.

import type { CommandKind } from '../types'

export const reviewCommentsKind: CommandKind = {
  id: 'review-comments',
  // No relay tools — built-in Edit/Read/Write cover everything.
  relayTools: [],
}
