// Lookup table from CommandKindId → CommandKind. The registry is the
// single source of truth for which kinds exist; .md files reference
// these ids, and unknown ids fall back to chat-message at load time.

import type { CommandKind, CommandKindId } from './types'
import { chatMessageKind } from './kinds/chatMessage'

export const KINDS: Record<CommandKindId, CommandKind> = {
  'chat-message': chatMessageKind,
  // document-edit and review-comments arrive in steps 5/6 — for now
  // these slots point at the safe default so loader validation can
  // still accept their ids without crashing.
  'document-edit': chatMessageKind,
  'review-comments': chatMessageKind,
}

export function resolveKind(id: string | undefined): CommandKind {
  if (id && id in KINDS) return KINDS[id as CommandKindId]
  return chatMessageKind
}
