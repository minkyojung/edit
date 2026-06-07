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
// Constructs: image (inline replace widget) + GFM table (BLOCK replace widget).
// We rebuild (re-scan the tree) ONLY when an edit could change a widget — it
// overlaps an existing one, or lands on a line containing `![`. Otherwise we keep
// the mapped set. Selection-only changes rebuild for the cursor-reveal (no
// position shift → no reload). Tables show raw while the caret is inside them and
// re-render via that selection rebuild when it leaves.

import { syntaxTree } from '@codemirror/language'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { StateField, type EditorState, type Extension, type Range, type Transaction } from '@codemirror/state'
import { ImageWidget, TableWidget } from '../widgets'

function cursorInRange(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) if (r.from <= to && from <= r.to) return true
  return false
}

function build(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = []
  syntaxTree(state).iterate({
    enter: (node) => {
      // Image — inline replace widget. Caret inside → show raw for editing.
      if (node.name === 'Image') {
        if (cursorInRange(state, node.from, node.to)) return false
        const m = /!\[([^\]]*)\]\(([^)\s]+)/.exec(state.doc.sliceString(node.from, node.to))
        if (m) out.push(Decoration.replace({ widget: new ImageWidget(m[2], m[1]) }).range(node.from, node.to))
        return false
      }
      // GFM table — BLOCK replace widget (whole block → a real <table>). Caret
      // anywhere in the table → show raw markdown for editing; it re-renders when
      // the caret leaves (the selection-change rebuild below).
      if (node.name === 'Table') {
        if (cursorInRange(state, node.from, node.to)) return false
        const from = state.doc.lineAt(node.from).from
        const to = state.doc.lineAt(Math.min(node.to, state.doc.length)).to
        out.push(
          Decoration.replace({ widget: new TableWidget(state.doc.sliceString(from, to)), block: true }).range(from, to),
        )
        return false
      }
      return undefined
    },
  })
  return Decoration.set(out, true)
}

/** Could this edit change which block widgets render (or their content)? True when
 * a change overlaps an existing (mapped) widget — image OR table — or lands on a
 * line containing `![` (a new image). Tables don't need a syntax check here: while
 * the caret is in a table it's shown raw (no widget), and it (re)renders when the
 * caret leaves via the selection-change rebuild. When false, the mapped set is
 * kept — so typing elsewhere never reloads/re-renders a widget. */
function touchesBlocks(tr: Transaction, mapped: DecorationSet): boolean {
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
    if (tr.docChanged) return touchesBlocks(tr, mapped) ? build(tr.state) : mapped
    if (tr.selection) return build(tr.state) // reveal; no position shift → no reload
    return mapped
  },
  provide: (f) => EditorView.decorations.from(f),
})

export const blocksV2: Extension = blocksField
