/**
 * Client-side mark actions: accept / reject / dismiss.
 *
 * These bypass the proof-server's HTTP ops API and operate directly on the
 * ProseMirror EditorView + Yjs Y.Map. Yjs auto-syncs both the doc text
 * (via y-prosemirror) and the Y.Map metadata to the server, mirroring how
 * proof-sdk's web client behaves.
 */

import type { EditorView } from '@milkdown/kit/prose/view'
import type { Mark, Node } from '@milkdown/kit/prose/model'
import * as Y from 'yjs'
import type { StoredMark } from '../hooks/useCollabDoc'
import { notify } from '@/lib/notify'

interface FoundAnchor {
  from: number
  to: number
  mark: Mark
}

const ANCHOR_SCHEMAS = ['proofSuggestion', 'proofComment'] as const

function findInlineAnchor(
  view: EditorView,
  markId: string,
  schemaName?: string,
): FoundAnchor | null {
  const targets = schemaName ? [schemaName] : ANCHOR_SCHEMAS
  let result: FoundAnchor | null = null
  view.state.doc.descendants((node, pos) => {
    if (result) return false
    if (!node.isText) return
    for (const m of node.marks) {
      if ((targets as readonly string[]).includes(m.type.name) && m.attrs.id === markId) {
        result = { from: pos, to: pos + node.nodeSize, mark: m }
        return false
      }
    }
  })
  return result
}

/**
 * Collect every text-node range that carries `markId` on the given
 * schema. Inline marks fragment across block boundaries — a single
 * proofSuggestion(insert) wrapping a heading + bullet list shows up
 * as N separate text nodes in PM (one per leaf-block run). Acting on
 * just the first (findInlineAnchor's behavior) leaves the rest
 * stranded, so the user has to click Keep N times. Walking the doc
 * once and returning all matching ranges lets accept transform the
 * whole proposal in a single transaction.
 */
function findAllMarkTextRanges(
  doc: Node,
  markId: string,
  schemaName: 'proofSuggestion' | 'proofComment',
): FoundAnchor[] {
  const ranges: FoundAnchor[] = []
  doc.descendants((node, pos) => {
    if (!node.isText) return
    for (const m of node.marks) {
      if (m.type.name === schemaName && m.attrs.id === markId) {
        ranges.push({ from: pos, to: pos + node.nodeSize, mark: m })
      }
    }
  })
  return ranges
}

/**
 * Outer span of the top-level blocks that contain any text marked with
 * `markId`. Used by reject(insert) so the user's single click removes
 * the entire proposal — heading + bullets + paragraphs — as one unit.
 *
 * Why block-level (not text-level): the inserted content is a tree of
 * blocks (h2 + ul + li...). Deleting only the marked text leaves empty
 * structural shells (an empty heading, empty bullets) that the user
 * would then have to delete manually. Walking top-level children and
 * including any whose subtree carries a matching mark gives the
 * minimal contiguous range that covers the proposal end-to-end.
 *
 * Returns null if no block carries the mark.
 */
function findMarkedBlockSpan(
  doc: Node,
  markId: string,
): { from: number; to: number } | null {
  let firstStart: number | null = null
  let lastEnd: number | null = null
  doc.forEach((blockNode, blockPos) => {
    let hasMark = false
    blockNode.descendants((descendant) => {
      if (hasMark) return false
      if (!descendant.isText) return
      for (const m of descendant.marks) {
        if (m.type.name === 'proofSuggestion' && m.attrs.id === markId) {
          hasMark = true
          return false
        }
      }
    })
    if (hasMark) {
      if (firstStart === null) firstStart = blockPos
      lastEnd = blockPos + blockNode.nodeSize
    }
  })
  if (firstStart === null || lastEnd === null) return null
  return { from: firstStart, to: lastEnd }
}

/**
 * Whether the live PM doc still carries a `proofSuggestion` mark with
 * this id. Returns true the moment any text node along the mark's
 * range has the suggestion attached, false otherwise.
 *
 * Why this exists: callers (hover toolbar, popover) used to gate
 * visibility on the Y.Map<StoredMark> entry — but Y.Map mutations are
 * NOT undone by ProseMirror's undo stack, so Cmd+Z after accept/reject
 * restored the PM mark while leaving Y.Map empty, hiding the affordance
 * even though the visual was back. Aligning visibility on the PM mark
 * itself matches the codebase's stated invariant
 * (markCleanupPlugin.ts:1-7): "the inline ProseMirror mark is the
 * single source of truth for whether a mark exists; Y.Map just holds
 * metadata."
 */
export function hasProofSuggestionInDoc(
  view: EditorView,
  markId: string,
): boolean {
  return findInlineAnchor(view, markId, 'proofSuggestion') !== null
}

export function acceptMark(view: EditorView, ydoc: Y.Doc, markId: string): boolean {
  const anchor = findInlineAnchor(view, markId, 'proofSuggestion')
  if (!anchor) {
    console.error('[markActions] accept: anchor not found', markId)
    notify.markCantApply()
    return false
  }
  const { from, to, mark } = anchor
  const kind = mark.attrs.kind as 'replace' | 'insert' | 'delete'
  // Pull content from the Y.Map StoredMark, not the PM mark attrs. The
  // server's markdown projection can strip mark.attrs.content during a
  // reconciliation round-trip; the Y.Map metadata syncs through Yjs binary
  // and survives that path intact.
  const marksMap = ydoc.getMap<StoredMark>('marks')
  const stored = marksMap.get(markId)
  const content = stored?.content ?? null

  const tr = view.state.tr
  // Track the inserted-content range so the insert path can stamp a
  // proofProvenance mark on the new text. Other kinds don't need this
  // (delete = nothing left, replace = anchor word becomes the content
  // and provenance there is a Phase 2.5 nice-to-have, not in scope).
  let provenanceRange: { from: number; to: number } | null = null
  // For insert kind, the proposal can fragment across many text nodes
  // (heading + bullet list = N runs). We collect every range up front
  // and walk it for both the proofSuggestion removal and the
  // proofProvenance addition so the whole proposal flips to "accepted"
  // in one transaction.
  let insertRanges: FoundAnchor[] = []
  if (kind === 'delete') {
    tr.delete(from, to)
  } else if (kind === 'replace') {
    if (content === null || content === undefined) {
      notify.markCantRead()
      return false
    }
    tr.replaceWith(from, to, view.state.schema.text(content))
  } else if (kind === 'insert') {
    // New model (single source of truth): the marked range IS the
    // proposed content — it's already in the PM tree from the
    // materializer (applyIngest:applyOneAsMark). Accept = transform
    // the mark in place: strip proofSuggestion, stamp proofProvenance
    // on every marked text range. Content stays put. No re-parse, no
    // re-insert.
    //
    // Why iterate every text node (not just `anchor`): a single
    // proofSuggestion(insert) wrapping a heading + bullet list lives
    // as N separate text-node ranges in PM (one per leaf-block run).
    // Operating on just the first leaves the rest stranded — the user
    // would have to click Keep N times to fully accept one proposal.
    // Walking once and transforming all ranges in one transaction
    // keeps Cmd+Z natural and matches the "one proposal = one user
    // decision" invariant.
    const suggestionType = view.state.schema.marks.proofSuggestion
    insertRanges = findAllMarkTextRanges(view.state.doc, markId, 'proofSuggestion')
    if (insertRanges.length === 0) {
      console.error('[markActions] accept(insert): no marked ranges', markId)
      notify.markCantApply()
      return false
    }
    if (suggestionType) {
      for (const r of insertRanges) tr.removeMark(r.from, r.to, suggestionType)
    }
    // provenanceRange is repurposed as the outer span just for
    // bookkeeping / readability; the actual provenance addMark below
    // walks insertRanges so each text node carries the breadcrumb.
    provenanceRange = {
      from: insertRanges[0].from,
      to: insertRanges[insertRanges.length - 1].to,
    }
  } else {
    return false
  }

  // Stamp proofProvenance on every accepted range in the same
  // transaction so the breadcrumb appears atomically with the
  // suggestion strip. For insert kind we walk insertRanges (one
  // entry per text-node run); other kinds collapse to a single
  // range stored in provenanceRange. Skipped entirely if the schema
  // lacks the mark (older client) — we fall through to the
  // delete-StoredMark path below, which preserves prior behavior.
  const provenanceType = view.state.schema.marks.proofProvenance
  if (provenanceType && stored) {
    const provenanceAttrs = {
      id: markId,
      sourceSlug: stored.sourceSlug ?? null,
      sourceLabel: stored.sourceLabel ?? null,
      sourceQuote: stored.sourceQuote ?? null,
      proposedAt: stored.proposedAt ?? stored.at ?? null,
      acceptedAt: new Date().toISOString(),
      model: stored.model ?? null,
    }
    if (insertRanges.length > 0) {
      for (const r of insertRanges) {
        tr.addMark(r.from, r.to, provenanceType.create(provenanceAttrs))
      }
    } else if (provenanceRange) {
      tr.addMark(
        provenanceRange.from,
        provenanceRange.to,
        provenanceType.create(provenanceAttrs),
      )
    }
  }
  view.dispatch(tr)

  // For insert kind, transform the StoredMark in place: same id, new
  // kind='provenance', acceptedAt added. The Y.Map entry now describes
  // a permanent breadcrumb instead of a pending suggestion. For other
  // kinds, keep prior behavior (delete the entry).
  if (provenanceRange && stored) {
    marksMap.set(markId, {
      ...stored,
      kind: 'provenance',
      status: 'accepted',
      acceptedAt: new Date().toISOString(),
    })
  } else {
    marksMap.delete(markId)
  }
  return true
}

export function rejectMark(view: EditorView, ydoc: Y.Doc, markId: string): boolean {
  const anchor = findInlineAnchor(view, markId, 'proofSuggestion')
  if (!anchor) {
    console.error('[markActions] reject: anchor not found', markId)
    notify.markCantDismiss()
    return false
  }
  const { from, to, mark } = anchor
  const kind = mark.attrs.kind as 'replace' | 'insert' | 'delete' | undefined
  const tr = view.state.tr
  if (kind === 'insert') {
    // New model: the marked range IS the proposed content (placed
    // there by the materializer). Reject = delete every top-level
    // block whose subtree carries this mark, so a multi-block
    // proposal (heading + bullets + paragraphs) disappears as a
    // single unit instead of leaving empty structural shells. One PM
    // transaction keeps Cmd+Z atomic.
    const span = findMarkedBlockSpan(view.state.doc, markId)
    if (!span) {
      console.error('[markActions] reject(insert): no marked block span', markId)
      notify.markCantDismiss()
      return false
    }
    tr.delete(span.from, span.to)
  } else {
    // replace / delete kinds (chat AI flows): the marked text is the
    // user's own writing; reject just strips the suggestion mark and
    // leaves the underlying text intact.
    const markType = view.state.schema.marks.proofSuggestion
    tr.removeMark(from, to, markType)
  }
  view.dispatch(tr)
  ydoc.getMap<StoredMark>('marks').delete(markId)
  return true
}

/** Silently remove a propose_change-produced mark (suggestion or comment).
 * Used when the assistant turn that owns the mark is being discarded —
 * e.g. handleRegenerate clearing the prior run's marks before the rerun
 * stamps fresh ones. Same effect as rejectMark / resolveComment but
 * without the user-facing notify side effect on missing anchors. */
export function cleanupMark(view: EditorView, ydoc: Y.Doc, markId: string): void {
  const stored = ydoc.getMap<StoredMark>('marks').get(markId)
  const schemaName = stored?.kind === 'comment' ? 'proofComment' : 'proofSuggestion'
  const anchor = findInlineAnchor(view, markId, schemaName)
  if (anchor) {
    const markType = view.state.schema.marks[schemaName]
    if (markType) {
      view.dispatch(view.state.tr.removeMark(anchor.from, anchor.to, markType))
    }
  }
  ydoc.getMap<StoredMark>('marks').delete(markId)
}
