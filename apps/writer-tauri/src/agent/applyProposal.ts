/**
 * Convert a Claude `propose_change` tool call into a server-side mark.
 *
 * Calls proof-server's canonical mutation surface
 * (`POST /documents/:slug/ops`) so the mark is created server-side
 * and broadcast back via Hocuspocus. The local PM editor + Y.Map
 * catch up via the existing WebSocket — no client-side Y.Doc writes
 * needed.
 *
 * Track 1.2 simplification: this used to compute char-offset anchors
 * client-side (buildTextIndex / posToCharOffset round-trip), wrap
 * `Y.Map<StoredMark>.set` + `tr.addMark` in a 'mark-action' transact,
 * and special-case empty docs by replacing the body inline. All of
 * that was workaround code for proof-server's drift detector when
 * the client originated the mutation. Going through /ops removes the
 * drift class entirely; the empty-doc fast path drops with it (the
 * server returns ANCHOR_NOT_FOUND for a quote that doesn't appear in
 * the doc, which the caller already routes to a toast).
 *
 * One known regression vs the old path: the proposal's `rationale`
 * (shown above the Keep/Reject hover bar) isn't preserved through
 * /ops — proof-sdk's mark schema doesn't carry it. If usage shows
 * this is meaningful we'll add a sibling `Y.Map('marksRationale')`
 * keyed by mark id, like authoredMeta.
 */

import { proofClient, OpsError, type OpsResponse } from '@/lib/proofClient'
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

  try {
    if (proposal.kind === 'suggestion') {
      const response = await proofClient.ops(slug, null, {
        type: 'suggestion.add',
        kind: proposal.suggestionType ?? 'replace',
        quote: proposal.quote,
        content: proposal.content,
        by: meta.agentId,
      })
      return toOutcome(response)
    }

    // proposal.kind === 'comment'
    const response = await proofClient.ops(slug, null, {
      type: 'comment.add',
      quote: proposal.quote,
      text: proposal.text,
      by: meta.agentId,
    })
    return toOutcome(response)
  } catch (err) {
    return toFailure(err)
  }
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

/**
 * proof-server returns `{ markId, ... }` for both suggestion.add and
 * comment.add (see document-engine.ts:1357 / 1563). A missing markId
 * would be a server-side regression — we treat it as a failure so the
 * caller doesn't log a phantom success.
 */
function toOutcome(response: OpsResponse): ApplyOutcome {
  const markId = response.markId
  if (typeof markId !== 'string' || !markId.trim()) {
    return { ok: false, reason: 'no_mark_id_in_response' }
  }
  return { ok: true, markId }
}

/** Map an OpsError code (ANCHOR_NOT_FOUND, STALE_REVISION, etc.) to
 * a stable reason string the chat logger / banner can act on. */
function toFailure(err: unknown): ApplyOutcome {
  if (err instanceof OpsError) {
    return { ok: false, reason: err.code ?? `ops_${err.status}` }
  }
  return { ok: false, reason: 'ops_failed' }
}
