// Convert a Claude propose_change call into an actual mark in the editor.
//
// Validates → resolves quote → stamps inline ProseMirror mark →
// writes metadata to Y.Map. Uses the same flow MarkToolbar uses for
// human-authored marks, plus AI-specific metadata fields (runId,
// agentId, focusAreaId, provisional) that proof-sdk's schema reserves.

import type { EditorView } from '@milkdown/kit/prose/view'
import * as Y from 'yjs'
import {
  buildTextIndex,
  mapTextOffsetsToRange,
  posToCharOffset,
  resolveQuoteRange,
} from '../editor/utils/textRange'
import type { StoredMark } from '../hooks/useCollabDoc'
import type { Proposal } from './proposals'

interface ApplyMeta {
  runId: string
  agentId: string
  focusAreaId?: string
}

export type ApplyOutcome =
  | { ok: true; markId: string }
  | { ok: false; reason: string }

function validate(proposal: Proposal, docText: string): string | null {
  if (!proposal.quote || !proposal.quote.trim()) return 'quote_empty'
  if (proposal.kind === 'suggestion') {
    if (
      (proposal.suggestionType === 'replace' || proposal.suggestionType === 'insert') &&
      !proposal.content?.trim()
    ) {
      return 'content_empty'
    }
    if (proposal.suggestionType === 'replace' && proposal.content === proposal.quote) {
      return 'noop_replace'
    }
  }
  if (proposal.kind === 'comment' && !proposal.text?.trim()) {
    return 'comment_empty'
  }
  if (!docText.includes(proposal.quote)) {
    // Fall through — resolveQuoteRange does normalized matching too. We
    // only fail outright if both literal and normalized lookups miss.
  }
  return null
}

export function applyProposal(
  view: EditorView,
  ydoc: Y.Doc,
  proposal: Proposal,
  meta: ApplyMeta,
): ApplyOutcome {
  const doc = view.state.doc
  const docText = doc.textBetween(0, doc.content.size, '\n', '\n')

  const baseError = validate(proposal, docText)
  if (baseError) return { ok: false, reason: baseError }

  const range = resolveQuoteRange(doc, proposal.quote)
  if (!range) return { ok: false, reason: 'quote_not_found' }

  const index = buildTextIndex(doc)
  if (!index) return { ok: false, reason: 'text_index_failed' }

  // Verify the resolved range is invertible to char offsets so the
  // server-side anchor metadata is consistent with the inline mark.
  const startChar = posToCharOffset(index, range.from)
  const lastCharIdx = posToCharOffset(index, range.to - 1)
  if (startChar === null || lastCharIdx === null) {
    return { ok: false, reason: 'anchor_mismatch' }
  }
  const endChar = lastCharIdx + 1

  // Confirm round-trip — char offsets back to PM range should match.
  const roundTrip = mapTextOffsetsToRange(index, startChar, endChar)
  if (!roundTrip || roundTrip.from !== range.from || roundTrip.to !== range.to) {
    return { ok: false, reason: 'anchor_round_trip_failed' }
  }

  const markId = crypto.randomUUID()
  const now = new Date().toISOString()

  // Y.Map metadata first (proof-sdk's StoredMark shape) so the decoration
  // plugin's first buildDecos pass — triggered by the PM transaction below
  // — finds `content` already in place. Reversing the order would race the
  // ghost-preview render against the metadata write.
  const marksMap = ydoc.getMap<StoredMark>('marks')
  const stored: StoredMark = {
    kind: proposal.kind === 'comment' ? 'comment' : (proposal.suggestionType ?? 'replace'),
    by: meta.agentId,
    quote: proposal.quote,
    startRel: `char:${startChar}`,
    endRel: `char:${endChar}`,
    at: now,
    ...(proposal.kind === 'suggestion'
      ? { content: proposal.content, status: 'pending' as const }
      : {}),
    ...(proposal.kind === 'comment' ? { text: proposal.text } : {}),
    ...(proposal.rationale ? { note: proposal.rationale } : {}),
  } as StoredMark
  marksMap.set(markId, stored)

  // Inline mark stamp. The PM mark is a pure anchor — only id / kind / by
  // ride along here. content / status / createdAt all live on the Y.Map
  // StoredMark we wrote above; readers (markDecoPlugin, markActions) look
  // them up there. Keeping the inline mark thin avoids the dual-source bug
  // where a server markdown round-trip strips PM attrs and the ghost goes
  // blank even though the metadata is intact.
  if (proposal.kind === 'suggestion') {
    const markType = view.state.schema.marks.proofSuggestion
    if (!markType) return { ok: false, reason: 'schema_proof_suggestion_missing' }
    view.dispatch(
      view.state.tr.addMark(
        range.from,
        range.to,
        markType.create({
          id: markId,
          kind: proposal.suggestionType,
          by: meta.agentId,
        }),
      ),
    )
  } else {
    const markType = view.state.schema.marks.proofComment
    if (!markType) return { ok: false, reason: 'schema_proof_comment_missing' }
    view.dispatch(
      view.state.tr.addMark(
        range.from,
        range.to,
        markType.create({ id: markId, by: meta.agentId }),
      ),
    )
  }

  return { ok: true, markId }
}
