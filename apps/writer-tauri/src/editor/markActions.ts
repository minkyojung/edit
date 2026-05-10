/**
 * Client-side mark actions: accept / reject / dismiss.
 *
 * These bypass the proof-server's HTTP ops API and operate directly on the
 * ProseMirror EditorView + Yjs Y.Map. Yjs auto-syncs both the doc text
 * (via y-prosemirror) and the Y.Map metadata to the server, mirroring how
 * proof-sdk's web client behaves.
 */

import type { EditorView } from '@milkdown/kit/prose/view'
import type { Mark } from '@milkdown/kit/prose/model'
import { TextSelection } from '@milkdown/kit/prose/state'
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
 * Move selection + scroll to the inline anchor of the given mark, and
 * briefly flash it. Returns true if the mark was found.
 */
export function jumpToMark(view: EditorView, markId: string): boolean {
  const anchor = findInlineAnchor(view, markId)
  if (!anchor) return false

  const tr = view.state.tr.setSelection(
    TextSelection.create(view.state.doc, anchor.from, anchor.to),
  )
  view.dispatch(tr.scrollIntoView())
  view.focus()

  flashRange(view, anchor.from, anchor.to)
  return true
}

function flashRange(view: EditorView, from: number, to: number) {
  // Walk the rendered DOM for the range and toggle a CSS class for ~1s.
  const startDom = view.domAtPos(from)
  const endDom = view.domAtPos(to)
  const start = startDom.node instanceof Element ? startDom.node : startDom.node.parentElement
  const end = endDom.node instanceof Element ? endDom.node : endDom.node.parentElement
  if (!start || !end) return

  const touched: Element[] = []
  let node: Element | null = start
  while (node) {
    touched.push(node)
    if (node === end) break
    const sibling: Element | null = node.nextElementSibling
    node = sibling ?? node.parentElement?.nextElementSibling ?? null
    if (touched.length > 50) break
  }
  for (const el of touched) el.classList.add('mark-flash')
  window.setTimeout(() => {
    for (const el of touched) el.classList.remove('mark-flash')
  }, 1000)
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
    // on the same range. Content stays put. No re-parse, no re-insert.
    //
    // Why no content read from Y.Map: the old anchor-word model
    // stored the proposed text in StoredMark.content because the doc
    // only had a placeholder; accept had to materialize the content.
    // Now the doc carries the content itself, so reading Y.Map.content
    // would either duplicate (if we re-inserted) or be unused.
    const suggestionType = view.state.schema.marks.proofSuggestion
    if (suggestionType) tr.removeMark(from, to, suggestionType)
    provenanceRange = { from, to }
  } else {
    return false
  }

  // Stamp proofProvenance on the inserted range in the same transaction
  // so the mark appears atomically with the inserted text. Skipped if
  // the schema lacks the mark (older client) — we fall through to the
  // delete-StoredMark path below, which preserves prior behavior.
  const provenanceType = view.state.schema.marks.proofProvenance
  if (provenanceRange && provenanceType && stored) {
    tr.addMark(
      provenanceRange.from,
      provenanceRange.to,
      provenanceType.create({
        id: markId,
        sourceSlug: stored.sourceSlug ?? null,
        sourceLabel: stored.sourceLabel ?? null,
        sourceQuote: stored.sourceQuote ?? null,
        proposedAt: stored.proposedAt ?? stored.at ?? null,
        acceptedAt: new Date().toISOString(),
        model: stored.model ?? null,
      }),
    )
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
    // there by the materializer). Reject = delete the range entirely
    // so the page returns to its pre-proposal state in a single PM
    // transaction (Cmd+Z restores the proposal cleanly).
    tr.delete(from, to)
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

export function resolveComment(view: EditorView, ydoc: Y.Doc, markId: string): boolean {
  const anchor = findInlineAnchor(view, markId, 'proofComment')
  if (anchor) {
    const markType = view.state.schema.marks.proofComment
    view.dispatch(view.state.tr.removeMark(anchor.from, anchor.to, markType))
  }
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
