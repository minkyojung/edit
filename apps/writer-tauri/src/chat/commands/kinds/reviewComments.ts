// Kind for /review and any future "scan the document, drop inline
// comment marks" commands. Same propose_change relay pipeline as
// document-edit, but the model emits many tool calls instead of one
// (each anchored to a different issue) and ChatPanel post-processes
// the run by replacing the assistant's text with a "Found N issues"
// summary so the chat surface stays uncluttered.

import type { CommandKind } from '../types'

export const reviewCommentsKind: CommandKind = {
  id: 'review-comments',
  relayTools: ['propose_change'],
}
