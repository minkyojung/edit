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
// Constructs: image (inline replace widget), GFM table + media (`<video>`/
// `<audio>`) BLOCK replace widgets.
// We rebuild (re-scan the tree) ONLY when an edit could change a widget — it
// overlaps an existing one, or lands on a line containing `![`. Otherwise we keep
// the mapped set. Selection-only changes rebuild for the cursor-reveal (no
// position shift → no reload). Tables show raw while the caret is inside them and
// re-render via that selection rebuild when it leaves.

import { syntaxTree } from '@codemirror/language'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import {
  EditorSelection,
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type Transaction,
} from '@codemirror/state'
import { ImageWidget, TableWidget } from '../widgets'
import { MediaWidget, detectMedia } from '../mediaCards'

function cursorInRange(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) if (r.from <= to && from <= r.to) return true
  return false
}

/** A COLLAPSED caret sits inside [from, to] → reveal raw for editing. */
function caretInside(state: EditorState, from: number, to: number): boolean {
  const s = state.selection.main
  return s.empty && s.from >= from && s.from <= to
}

/** A non-empty selection fully spans [from, to] → the block is "selected"
 * (e.g. via click-to-select) → render the widget with a border. */
function blockSelected(state: EditorState, from: number, to: number): boolean {
  const s = state.selection.main
  return !s.empty && s.from <= from && s.to >= to
}

function build(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = []
  syntaxTree(state).iterate({
    enter: (node) => {
      // Image — inline replace widget. A COLLAPSED caret inside → raw (edit); a
      // selection spanning it → rendered with a border (click-to-select).
      if (node.name === 'Image') {
        if (caretInside(state, node.from, node.to)) return false
        const m = /!\[([^\]]*)\]\(([^)\s]+)/.exec(state.doc.sliceString(node.from, node.to))
        if (m) {
          const sel = blockSelected(state, node.from, node.to)
          out.push(Decoration.replace({ widget: new ImageWidget(m[2], m[1], sel) }).range(node.from, node.to))
        }
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
      // Media — `<video>`/`<audio>` parse as a Paragraph holding HTMLTag children;
      // match the paragraph whose text is a media tag → BLOCK widget (reuses the
      // app's createMediaControls). Caret inside → raw. Map preserves the live
      // <video> element (and its playback position) across edits above it. Other
      // paragraphs return undefined so iteration descends to inline Images.
      if (node.name === 'Paragraph') {
        const media = detectMedia(state.doc.sliceString(node.from, node.to))
        if (!media) return undefined
        if (cursorInRange(state, node.from, node.to)) return false
        const from = state.doc.lineAt(node.from).from
        const to = state.doc.lineAt(Math.min(node.to, state.doc.length)).to
        out.push(
          Decoration.replace({
            widget: new MediaWidget(media.kind, media.src, media.title),
            block: true,
          }).range(from, to),
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
    if (tr.selection) return build(tr.state) // reveal / selected; no shift → no reload
    return mapped
  },
  provide: (f) => EditorView.decorations.from(f),
})

// Click a rendered block card → select the WHOLE widget as a unit (the source
// range), so it shows a border instead of dropping a caret inside. (CM has no
// built-in "click atomic range to select" — Marijn's recommendation is exactly
// this: find the range at the click and select it.) The selection then drives the
// `blockSelected` border via the field above. Editing the raw is still reachable
// by arrowing a caret into the card.
const blockClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    const el = (event.target as HTMLElement | null)?.closest?.('.cm-img')
    if (!el) return false
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
    if (pos == null) return false
    const hits: { from: number; to: number }[] = []
    view.state.field(blocksField).between(0, view.state.doc.length, (from, to) => {
      if (from <= pos && pos <= to) hits.push({ from, to })
    })
    if (hits.length === 0) return false
    event.preventDefault()
    view.dispatch({ selection: EditorSelection.range(hits[0].from, hits[0].to) })
    return true
  },
})

export const blocksV2: Extension = [blocksField, blockClick]
