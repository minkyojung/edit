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

function build(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = []
  syntaxTree(state).iterate({
    enter: (node) => {
      // Image — same model as the media card. Two modes:
      //  • editing (cursor OR selection touching it) → KEEP the raw `![...](...)`
      //    source visible AND show the image preview as a block right below it
      //    (Obsidian-style: code on top, picture under). `cursorInRange` (not a
      //    collapsed-only test) keeps it revealed while you SELECT the source, so
      //    you can drag that text to move the image.
      //  • otherwise → replace the source with the image (no click-select/border).
      if (node.name === 'Image') {
        const m = /!\[([^\]]*)\]\(([^)\s]+)/.exec(state.doc.sliceString(node.from, node.to))
        if (!m) return false
        if (cursorInRange(state, node.from, node.to)) {
          const lineEnd = state.doc.lineAt(node.to).to
          out.push(
            Decoration.widget({ widget: new ImageWidget(m[2], m[1]), block: true, side: 1 }).range(lineEnd),
          )
          return false
        }
        out.push(Decoration.replace({ widget: new ImageWidget(m[2], m[1]) }).range(node.from, node.to))
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
        // Editing (cursor OR a selection touching the line) → KEEP the raw
        // `<video>`/`<audio>` source visible AND show the player as a block right
        // below it (Obsidian-style: code on top, media under). `cursorInRange`
        // (not `caretInside`) is deliberate: a COLLAPSED-only test would drop the
        // reveal the instant you drag to select the source — the text would turn
        // back into the player mid-drag and you'd grab the player instead. Keeping
        // it revealed for any touching selection lets you cleanly select & drag the
        // source text to move the block, exactly like Obsidian.
        if (cursorInRange(state, node.from, node.to)) {
          const lineEnd = state.doc.lineAt(node.to).to
          out.push(
            Decoration.widget({
              widget: new MediaWidget(media.kind, media.src, media.title),
              block: true,
              side: 1,
            }).range(lineEnd),
          )
          return false
        }
        // INLINE replace (NOT block) — exactly like the image. A `block: true`
        // replace turns the whole line into a non-text block that the caret SKIPS
        // over on arrow-down (no text position to land on), so the source could
        // never be revealed by moving the caret. An inline replace keeps the line
        // caret-addressable, so arrowing onto it reveals the source (above).
        out.push(
          Decoration.replace({
            widget: new MediaWidget(media.kind, media.src, media.title),
          }).range(node.from, node.to),
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

export const blocksV2: Extension = [blocksField]
