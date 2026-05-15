/**
 * Convert a Claude `propose_change` tool call into a mark.
 *
 * Phase 2.4 — re-routed from `proofClient.ops(/suggestion.add/comment.add)`
 * to `markStore.add`. The previous /ops round-trip was what surfaced the
 * 409 Conflict the user hit on /proofread: proof-server's projection
 * repair couldn't serialize our Y.XmlFragment (`node.children.some`
 * crash class), so the server held the doc in PROJECTION_STALE and
 * rejected every /ops call against it.
 *
 * Going through markStore writes the mark directly into the local
 * Y.Doc + ProseMirror under a single 'mark-action' origin. proof-server
 * keeps running in the background — its projection repair still fails
 * in its own logs, but the user-visible mark life-cycle is now
 * decoupled from that failure. Phase 3 removes the server entirely.
 *
 * Validation responsibilities split:
 *   - This file: domain validation that callers (chat.ts) already
 *     have stable reason codes for ('quote_empty', 'content_empty',
 *     'noop_replace', 'comment_empty'). Kept verbatim.
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
          by: meta.agentId,
        })
      : await markStore.add({
          slug,
          kind: 'comment',
          quote: proposal.quote,
          text: proposal.text,
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
