// Lookup table from CommandKindId → CommandKind. The registry is the
// single source of truth for which kinds exist; .md files reference
// these ids, and unknown ids fall back to chat-message at load time.

import type { CommandKind, CommandKindId } from './types'
import { chatMessageKind } from './kinds/chatMessage'
import { documentEditKind } from './kinds/documentEdit'

export const KINDS: Record<CommandKindId, CommandKind> = {
  'chat-message': chatMessageKind,
  'document-edit': documentEditKind,
  // review-comments arrives in step 6 — for now points at chat-message
  // so the loader can still accept the kind id without crashing.
  'review-comments': chatMessageKind,
}

export function resolveKind(id: string | undefined): CommandKind {
  if (id && id in KINDS) return KINDS[id as CommandKindId]
  return chatMessageKind
}
