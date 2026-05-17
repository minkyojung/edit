/**
 * Convert a Claude `propose_change` tool call into a mark.
 *
 * Writes the mark directly into the doc's Y.Doc + ProseMirror via
 * markStore.add (single 'mark-action' Yjs origin so UndoManager
 * folds it into one undo step).
 *
 * Validation responsibilities split:
 *   - This file: domain validation that callers (chat.ts) already
 *     have stable reason codes for ('quote_empty', 'content_empty',
 *     'noop_replace', 'comment_empty').
 *   - markStore.add: anchor existence, view readiness, internal
 *     shape. Its failure reasons (`view_not_ready`, `anchor_not_found`,
 *     `invalid_args`, `noop`) are translated to ApplyOutcome reasons
 *     below so the call site doesn't have to learn the new vocab.
 */

import { markStore } from '@/domain/markStoreInstance'
import type { AddMarkFailureReason } from '@/domain/markStore'
import type { Proposal } from './proposals'

export interface ApplyMeta {
  runId: string
  agentId: string
  focusAreaId?: string
}

export type ApplyOutcome =
  | { ok: true; markId: string }
  | { ok: false; reason: string }

export async function applyProposal(
  slug: string,
  proposal: Proposal,
  meta: ApplyMeta,
): Promise<ApplyOutcome> {
  const reason = validate(proposal)
  if (reason) return { ok: false, reason }

  const result =
    proposal.kind === 'suggestion'
      ? await markStore.add({
          slug,
          kind: 'suggestion',
          suggestionType: proposal.suggestionType,
          quote: proposal.quote,
          content: proposal.content,
          rationale: proposal.rationale,
          by: meta.agentId,
        })
      : await markStore.add({
          slug,
          kind: 'comment',
          quote: proposal.quote,
          text: proposal.text,
          rationale: proposal.rationale,
          by: meta.agentId,
        })

  if (result.ok) return { ok: true, markId: result.markId }
  return { ok: false, reason: translateReason(result.reason) }
}

function validate(proposal: Proposal): string | null {
  if (!proposal.quote || !proposal.quote.trim()) return 'quote_empty'
  if (proposal.kind === 'suggestion') {
    const needsContent =
      proposal.suggestionType === 'replace' || proposal.suggestionType === 'insert'
    if (needsContent && !proposal.content?.trim()) return 'content_empty'
    if (
      proposal.suggestionType === 'replace' &&
      proposal.content === proposal.quote
    ) {
      return 'noop_replace'
    }
  }
  if (proposal.kind === 'comment' && !proposal.text?.trim()) {
    return 'comment_empty'
  }
  return null
}

/** Map markStore.add failure reasons to the reason strings chat.ts /
 * the banner UI already understand. `view_not_ready` and `anchor_not_
 * found` are the two new cases the legacy /ops path couldn't surface;
 * keeping their codes verbatim so the chat logger and any future
 * filters (e.g. "retry on view_not_ready") can branch on them
 * directly. */
function translateReason(reason: AddMarkFailureReason): string {
  switch (reason) {
    case 'view_not_ready':
      return 'view_not_ready'
    case 'anchor_not_found':
      return 'anchor_not_found'
    case 'noop':
      return 'noop_replace'
    case 'invalid_args':
      return 'invalid_args'
  }
}
