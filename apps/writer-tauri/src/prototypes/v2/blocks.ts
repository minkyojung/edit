// Widget / block decorations for the v2 core — kept in a StateField (separate
// from the inline/line ViewPlugin) for two reasons the CM docs spell out:
//   1. block decorations (tables, cards — later) may only be provided DIRECTLY,
//      from a state field, never from a viewport ViewPlugin;
//   2. a field value can be MAPPED through document changes, so editing ABOVE a
//      widget MOVES it (same widget instance → eq → same DOM) instead of
//      rebuilding it. Rebuilding re-creates the widget at the shifted position,
//      which CM can't match to the old one, so it tears down + redraws it — for
//      an <img> that means a reload, i.e. the height flashes and everything below
//      jumps (the "earthquake"). Mapping avoids that.
//
// STEP: images only. We rebuild (re-scan the tree) ONLY when an edit could change
// which images exist or their src — the change overlaps an existing image, or it
// lands on a line containing `![`. Otherwise we keep the mapped set. Selection-
// only changes rebuild for the cursor-reveal (no position shift → no reload).

import { syntaxTree } from '@codemirror/language'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { StateField, type EditorState, type Extension, type Range, type Transaction } from '@codemirror/state'
import { ImageWidget } from '../widgets'

function cursorInRange(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) if (r.from <= to && from <= r.to) return true
  return false
}

function build(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = []
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'Image') return undefined
      // Caret inside the image markdown → show raw for editing.
      if (cursorInRange(state, node.from, node.to)) return false
      const m = /!\[([^\]]*)\]\(([^)\s]+)/.exec(state.doc.sliceString(node.from, node.to))
      if (m) out.push(Decoration.replace({ widget: new ImageWidget(m[2], m[1]) }).range(node.from, node.to))
      return false
    },
  })
  return Decoration.set(out, true)
}

/** Could this edit change which images render (or their src)? True when a change
 * overlaps an existing (mapped) image, or lands on a line that contains `![`.
 * When false, the mapped set is kept — so typing elsewhere never reloads an img. */
function touchesImages(tr: Transaction, mapped: DecorationSet): boolean {
  let touched = false
  tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
    if (touched) return
    mapped.between(fromB, toB, () => {
      touched = true
      return false
    })
    if (!touched && tr.state.doc.lineAt(fromB).text.includes('![')) touched = true
  })
  return touched
}

const blocksField = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update: (value, tr) => {
    const mapped = value.map(tr.changes)
    if (tr.docChanged) return touchesImages(tr, mapped) ? build(tr.state) : mapped
    if (tr.selection) return build(tr.state) // reveal; no position shift → no reload
    return mapped
  },
  provide: (f) => EditorView.decorations.from(f),
})

export const blocksV2: Extension = blocksField
