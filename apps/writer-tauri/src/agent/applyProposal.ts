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
      // Preserve the title slot — non-daily docs always carry a
      // level-1 heading as their first child (see lib/docTitle.ts),
      // and the title-guard plugin refuses any transaction that
      // would remove it. We splice the proposal AFTER the first h1
      // instead of replacing from position 0. Daily docs (no leading
      // h1) and pre-migration docs (paragraph first) fall back to
      // replacing the whole body, preserving their existing behavior.
      const firstChild = doc.firstChild
      const insertFrom =
        firstChild && firstChild.type.name === 'heading' && firstChild.attrs.level === 1
          ? firstChild.nodeSize
          : 0
      const markId = crypto.randomUUID()
      ydoc.transact(() => {
        view.dispatch(
          view.state.tr.replaceWith(insertFrom, doc.content.size, parsed.content),
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

  // Resolve the inline mark type up front so the schema-missing branch
  // can early-return before we open the Yjs transaction below. Keeps
  // the transact body to its two essential writes.
  let inlineMark
  if (proposal.kind === 'suggestion') {
    const markType = view.state.schema.marks.proofSuggestion
    if (!markType) return { ok: false, reason: 'schema_proof_suggestion_missing' }
    inlineMark = markType.create({
      id: markId,
      kind: proposal.suggestionType,
      by: meta.agentId,
    })
  } else {
    const markType = view.state.schema.marks.proofComment
    if (!markType) return { ok: false, reason: 'schema_proof_comment_missing' }
    // Stamp the comment body / quoted span / rationale onto the mark
    // itself so PM undo restores them together. The Y.Map.set inside
    // the transact below mirrors the data for legacy readers
    // (DocumentInfoDialog stats); the popover reads from the PM mark
    // instead so resolved-then-undone comments don't lose their text.
    inlineMark = markType.create({
      id: markId,
      by: meta.agentId,
      text: proposal.text ?? null,
      quote: proposal.quote ?? null,
      note: proposal.rationale ?? null,
    })
  }

  // Wrap the Y.Map metadata write and the PM mark stamp in one Yjs
  // transaction with the 'mark-action' origin so Cmd+Z restores both
  // atomically — mirrors MarkToolbar.submit and markActions.acceptMark/
  // rejectMark. Without the wrap, Cmd+Z would only undo the PM half
  // and the Y.Map entry would linger (the dual-source bug acceptMark
  // had until it adopted this same pattern; see markActions.ts:182-194).
  //
  // Order inside the transact: Y.Map.set first, then view.dispatch.
  // The markDecoPlugin's buildDecos pass runs during the PM dispatch
  // and reads the marks map synchronously; with the write coming
  // first, the ghost preview finds `content` already in place. Inside
  // a single transact the observers fire only after both writes
  // commit, but the synchronous PM-side read still needs the map
  // populated when dispatch runs.
  ydoc.transact(() => {
    marksMap.set(markId, stored)
    view.dispatch(view.state.tr.addMark(range.from, range.to, inlineMark))
  }, 'mark-action')

  return { ok: true, markId }
}
