// Kind for slash commands that rewrite a passage in the document body
// (`/shorten`, `/expand`, `/polish`). The model returns one
// `edit_document` tool call per rewrite; the chat engine's edit
// listener splices the doc in place and emits a single git commit
// summarising the turn. The previous mark-based accept/reject UI
// retired in Phase 3 — review happens via git Undo in the Review
// panel.

import type { CommandKind } from '../types'

export const documentEditKind: CommandKind = {
  id: 'document-edit',
  relayTools: ['edit_document'],
}
