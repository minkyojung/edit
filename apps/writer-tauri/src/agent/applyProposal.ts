// Convert a Claude propose_change call into an actual mark in the editor.
//
// Validates → resolves quote → stamps inline ProseMirror mark →
// writes metadata to Y.Map. Uses the same flow MarkToolbar uses for
// human-authored marks, plus AI-specific metadata fields (runId,
// agentId, focusAreaId, provisional) that proof-sdk's schema reserves.

import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node } from '@milkdown/kit/prose/model'
import * as Y from 'yjs'
import {
  buildTextIndex,
  mapTextOffsetsToRange,
  posToCharOffset,
  resolveQuoteRange,
} from '../editor/utils/textRange'
import { useEditorViewStore } from '@/state/editorViewStore'
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

/** Position of the slot directly after the top-level block that
 * contains `pos`. Mirrors ingest's pos-0 materializer but anchored to
 * the chat-supplied quote: the LLM said "insert after this line", so
 * we drop the new content as the next top-level sibling rather than
 * splicing inline (which breaks for multi-block content like a heading
 * + bullet list). depth=1 because depth 0 is the doc itself; the
 * top-level block is always at depth 1. */
function topLevelSiblingAfter(doc: Node, pos: number): number {
  const $pos = doc.resolve(pos)
  return Math.min($pos.end(1) + 1, doc.content.size)
}

/** Materialize a chat-emitted INSERT proposal as real PM blocks +
 * a pending suggestion mark — same single-source-of-truth shape ingest
 * uses. Replaces the legacy path where INSERT marked an "anchor word"
 * placeholder in the doc and stashed the proposed content in
 * Y.Map.content (visible only via a ghost widget that was removed in
 * 65f33815). With ghost gone and no PM-tree fallback, chat-INSERT
 * showed nothing. This brings it onto ingest's path so any LLM that
 * picks suggestionType: 'insert' renders correctly, and so chat /
 * ingest INSERT marks are visually + behaviorally identical.
 *
 * Insert position: the top-level sibling right after the quote's
 * containing block. If the quote can't be located (rare), fall back to
 * pos 0 so we still surface the proposal somewhere visible — same
 * fallback ingest uses. */
function materializeInsert(
  view: EditorView,
  proposal: Proposal,
  meta: ApplyMeta,
  markId: string,
): ApplyOutcome {
  const content = proposal.kind === 'suggestion' ? proposal.content : null
  if (!content || !content.trim()) return { ok: false, reason: 'content_empty' }

  const parser = useEditorViewStore.getState().parser
  if (!parser) return { ok: false, reason: 'parser_not_ready' }

  const parsed = parser(content)
  if (!parsed || parsed.content.size === 0) {
    return { ok: false, reason: 'parser_empty' }
  }

  const markType = view.state.schema.marks.proofSuggestion
  if (!markType) return { ok: false, reason: 'schema_proof_suggestion_missing' }

  // Resolve where to insert. quote is required by validate(), so
  // it's always non-empty here, but the resolver can still miss if
  // the doc has drifted since the LLM read it.
  let insertPos = 0
  if (proposal.quote) {
    const range = resolveQuoteRange(view.state.doc, proposal.quote)
    if (range) insertPos = topLevelSiblingAfter(view.state.doc, range.to)
  }

  const fragmentSize = parsed.content.size
  view.dispatch(
    view.state.tr
      .insert(insertPos, parsed.content)
      .addMark(
        insertPos,
        insertPos + fragmentSize,
        markType.create({
          id: markId,
          kind: 'insert',
          by: meta.agentId,
        }),
      ),
  )

  // No Y.Map.set: PM is the single source of truth for INSERT marks
  // (same as ingest post Step 1). acceptMark/rejectMark already read
  // from the live PM mark, and markCleanupPlugin will skip the
  // never-written entry on its own.
  return { ok: true, markId }
}

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

  // INSERT short-circuits onto the materialize path — the proposed
  // content becomes real PM blocks, the mark wraps those blocks, and
  // Y.Map stays untouched. Replace / delete / comment fall through to
  // the legacy quote-range stamp + Y.Map.set flow below; those paths
  // are migrated separately.
  if (proposal.kind === 'suggestion' && proposal.suggestionType === 'insert') {
    const markId = crypto.randomUUID()
    return materializeInsert(view, proposal, meta, markId)
  }

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
