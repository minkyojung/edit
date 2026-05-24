// Kind for /review and any future "scan the document and apply
// every fix" commands. Same `edit_document` relay pipeline as
// document-edit, but the model emits many tool calls instead of one
// (each rewriting a different issue) and ChatPanel post-processes
// the run by replacing the assistant's text with a "Found N issues"
// summary so the chat surface stays uncluttered. With marks gone
// (Phase 3) every edit_document call lands in the body directly;
// the user reviews via the git Review panel rather than per-mark
// accept/reject.

import type { CommandKind } from '../types'

export const reviewCommentsKind: CommandKind = {
  id: 'review-comments',
  relayTools: ['edit_document'],
}
