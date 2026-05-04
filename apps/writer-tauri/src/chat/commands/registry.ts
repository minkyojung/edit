// Lookup table from CommandKindId → CommandKind. The registry is the
// single source of truth for which kinds exist; .md files reference
// these ids, and unknown ids fall back to chat-message at load time.

import type { CommandKind, CommandKindId } from './types'
import { chatMessageKind } from './kinds/chatMessage'
import { documentEditKind } from './kinds/documentEdit'
import { reviewCommentsKind } from './kinds/reviewComments'

export const KINDS: Record<CommandKindId, CommandKind> = {
  'chat-message': chatMessageKind,
  'document-edit': documentEditKind,
  'review-comments': reviewCommentsKind,
}

export function resolveKind(id: string | undefined): CommandKind {
  if (id && id in KINDS) return KINDS[id as CommandKindId]
  return chatMessageKind
}
