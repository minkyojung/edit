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
import { useEditorViewStore } from '@/state/editorViewStore'
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

  // Empty-doc fast path. The proof-sdk anchor → ghost → accept pattern
  // presupposes existing text to anchor on; when the doc has no visible
  // content there is nothing to anchor and nothing to negotiate against
  // (accept of an empty-doc insert would always succeed, reject would
  // always be "stay empty"). Skip the mark ceremony entirely and install
  // the proposed content as the new doc body — the same end-state
  // markActions.acceptMark would have produced via parser → tr.insert.
  // Wrapped in 'mark-action' origin so Cmd+Z restores the empty doc in
  // one step, matching how accept(insert) on a non-empty doc behaves.
  if (proposal.kind === 'suggestion' && proposal.suggestionType === 'insert') {
    // Strip zero-width chars (U+200B-200D ZWS/ZWNJ/ZWJ + U+FEFF BOM) and
    // whitespace. The proof-server seeds empty docs with U+200B so the
    // markdown projection passes its non-empty validation; this leaks
    // into doc.textBetween on the client and would otherwise mask the
    // "empty doc" condition.
    const docVisible = docText.replace(/[\u200B-\u200D\uFEFF\s]/g, '')
    if (!docVisible) {
      if (!proposal.content?.trim()) return { ok: false, reason: 'content_empty' }
      const parser = useEditorViewStore.getState().parser
      if (!parser) return { ok: false, reason: 'parser_not_ready' }
      const parsed = parser(proposal.content)
      if (!parsed || parsed.content.size === 0) {
        return { ok: false, reason: 'parsed_empty' }
      }
      const markId = crypto.randomUUID()
      ydoc.transact(() => {
        view.dispatch(
          view.state.tr.replaceWith(0, doc.content.size, parsed.content),
        )
      }, 'mark-action')
      return { ok: true, markId }
    }
  }

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
    // Stamp the comment body / quoted span / rationale onto the mark
    // itself so PM undo restores them together. The Y.Map.set above
    // mirrors the data for legacy readers (DocumentInfoDialog stats);
    // the popover reads from the PM mark instead so resolved-then-undone
    // comments don't lose their text.
    view.dispatch(
      view.state.tr.addMark(
        range.from,
        range.to,
        markType.create({
          id: markId,
          by: meta.agentId,
          text: proposal.text ?? null,
          quote: proposal.quote ?? null,
          note: proposal.rationale ?? null,
        }),
      ),
    )
  }

  return { ok: true, markId }
}
