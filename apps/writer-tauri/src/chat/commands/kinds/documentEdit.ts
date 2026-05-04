// Kind for slash commands that rewrite a passage in the document body
// (`/shorten`, `/expand`, `/polish`). The model returns a single
// `propose_change` tool call with kind=suggestion, suggestionType=replace
// — the existing relay + applyProposal pipeline picks it up and the
// inline mark + MarkPopover handle accept/reject. No new UI plumbing.

import type { CommandKind } from '../types'

export const documentEditKind: CommandKind = {
  id: 'document-edit',
  relayTools: ['propose_change'],
}
