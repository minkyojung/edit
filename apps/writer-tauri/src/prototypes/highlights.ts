// Highlights (read-it-later) the CM-native way: records are the source of
// truth (real app: article .meta.json), the body markdown is never touched.
// A StateField re-anchors each record (quote + occurrence) by offset search
// and paints a `cm-highlight` mark decoration. No schema, no addToHistory
// dance, no data-attr round-trip — a pure view-only overlay. Structurally the
// same "anchored decoration layer" as the AI suggestion marks we already
// proved.

import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { isComposing, compositionEnded } from './imeComposition'

export interface HighlightRecord {
  id: string
  quote: string
  note?: string
  occurrence: number // 0-based: which occurrence of `quote` in the doc
}

/** Range of the `occurrence`-th `quote` in `text`, or null. Offset search —
 * the CM analog of PM's findHighlightRange, minus the tree walk. */
export function rangeFor(
  text: string,
  quote: string,
  occurrence: number,
): { from: number; to: number } | null {
  if (!quote) return null
  let idx = -1
  for (let i = 0; i <= occurrence; i++) {
    idx = text.indexOf(quote, idx + 1)
    if (idx < 0) return null
  }
  return { from: idx, to: idx + quote.length }
}

/** Which occurrence of `quote` starts at `selFrom` (for recording a new
 * highlight). Counts matches strictly before selFrom. */
export function occurrenceAt(text: string, quote: string, selFrom: number): number {
  if (!quote) return 0
  let count = 0
  let idx = text.indexOf(quote)
  while (idx >= 0 && idx < selFrom) {
    count++
    idx = text.indexOf(quote, idx + 1)
  }
  return count
}

/** Replace the highlight record set (create/remove/note edits go through here
 * in the real app; the marks follow). */
export const setHighlights = StateEffect.define<HighlightRecord[]>()

/** Records (source of truth) held in editor state for the prototype. */
export const highlightRecords = StateField.define<HighlightRecord[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setHighlights)) return e.value
    return value
  },
})

function build(state: EditorState): DecorationSet {
  const text = state.doc.toString()
  const decos: Range<Decoration>[] = []
  for (const r of state.field(highlightRecords)) {
    const range = rangeFor(text, r.quote, r.occurrence)
    if (range && range.to > range.from) {
      decos.push(
        Decoration.mark({
          class: 'cm-highlight',
          attributes: { 'data-hl-id': r.id },
        }).range(range.from, range.to),
      )
    }
  }
  return Decoration.set(decos, true)
}

/** The highlight decoration layer (depends on highlightRecords). */
export const highlightField = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update(value, tr) {
    if (isComposing(tr.state)) return value
    if (tr.docChanged || tr.effects.some((e) => e.is(setHighlights)) || compositionEnded(tr)) {
      return build(tr.state)
    }
    return value
  },
  provide: (f) => EditorView.decorations.from(f),
})

/** Click a highlight → onClick(id, note). (Real app: select range + open the
 * note/remove menu.) */
export function highlightClick(onClick: (id: string, note: string | undefined) => void): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      const el = (event.target as HTMLElement | null)?.closest('[data-hl-id]')
      if (!el) return false
      const id = el.getAttribute('data-hl-id')
      if (!id) return false
      const rec = view.state.field(highlightRecords).find((r) => r.id === id)
      onClick(id, rec?.note)
      return false // leave caret/selection to default
    },
  })
}

/** Assemble the highlight extension with an initial record set. Order matters:
 * records field before the decoration field that reads it. */
export function highlights(initial: HighlightRecord[]): Extension {
  return [highlightRecords.init(() => initial), highlightField]
}
