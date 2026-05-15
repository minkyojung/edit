/**
 * Convert a Claude `propose_change` tool call into a server-side mark.
 *
 * Sends `POST /documents/:slug/ops` so the server creates the mark
 * canonically and broadcasts the resulting Yjs update through
 * Hocuspocus. The local PM editor + Y.Map catch up via the existing
 * WebSocket — no client-side Y.Doc writes here.
 *
 * Why this matters (Track 1.2 second attempt):
 *   The previous client-side path (Y.Map.set + tr.addMark wrapped in
 *   `ydoc.transact(..., 'mark-action')`) only persisted to the
 *   server's marks JSON via the Yjs binary sync. When the WebSocket
 *   was momentarily disconnected (token expiry, network blip) the
 *   mark stayed local; subsequent /ops mutations would fail with
 *   "Mark not found". The drift detector layered on top of that —
 *   server projection repair occasionally reverted client-originated
 *   writes, the source of split-tr / anchor-on-existing-text
 *   workarounds.
 *
 *   Going through /ops makes the server originate the mark. WebSocket
 *   disconnect no longer matters for mark creation (the HTTP call
 *   carries the full payload); drift detection can't fire on changes
 *   the server itself produced.
 *
 * One known regression deferred for v2:
 *   - `proposal.rationale` (shown above the Keep/Reject hover bar)
 *     isn't preserved through /ops because proof-sdk's mark schema
 *     doesn't carry it. If usage demands the rationale text back,
 *     add a sibling `Y.Map('marksRationale')` keyed by mark id, the
 *     same pattern as `Y.Map('authoredMeta')`. Leaving it out for
 *     now keeps the migration narrow.
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
 * comment.add (see proof-sdk/server/document-engine.ts:1357 / 1563).
 * A missing markId would be a server-side regression — we treat it
 * as a failure so the caller doesn't log a phantom success.
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
