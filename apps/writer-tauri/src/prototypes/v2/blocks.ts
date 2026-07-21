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
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view'
import {
  Prec,
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type Transaction,
} from '@codemirror/state'
import { type SyntaxNode } from '@lezer/common'
import { ImageWidget } from '../widgets'
import { EditableTableWidget } from './editableTable'
import { MediaWidget, detectMedia } from '../mediaCards'
import { inProofRawRange } from '@/editor/proofRawRanges'
import { cursorInRange } from './cursorRange'

function build(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = []
  syntaxTree(state).iterate({
    enter: (node) => {
      // Pending AI proposal (Option B): keep it RAW — don't render its table /
      // image as a widget, so the proposal stays distinguishable + editable.
      if (inProofRawRange(state, node.from)) return false
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
      // GFM table — BLOCK replace widget, ALWAYS rendered (in-place editing). The
      // cells are contenteditable; there's no raw-markdown reveal. Editing a cell
      // commits one transaction; the widget re-renders (eq/updateDOM keep focus).
      if (node.name === 'Table') {
        const from = state.doc.lineAt(node.from).from
        const to = state.doc.lineAt(Math.min(node.to, state.doc.length)).to
        out.push(
          Decoration.replace({ widget: new EditableTableWidget(state.doc.sliceString(from, to)), block: true }).range(
            from,
            to,
          ),
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

/** Is `pos` inside a GFM `Table` node? Tables render unconditionally (build always
 * emits the widget), so the field just needs to KNOW a change/selection involves a
 * table to trigger a rebuild. */
function inTableAt(state: EditorState, pos: number): boolean {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === 'Table') return true
  }
  return false
}

/** Could this edit change which block widgets render (or their content)? True when
 * a change overlaps an existing (mapped) widget — image OR table — lands on a line
 * containing `![` (a new image), or lands inside a table (a freshly-inserted or
 * edited GFM table). The table check is REQUIRED: an inserted table isn't near an
 * existing widget and has no `![`, so without it the table stays raw markdown until
 * some unrelated later rebuild. When false, the mapped set is kept — so typing
 * elsewhere never reloads/re-renders a widget. */
function touchesBlocks(tr: Transaction, mapped: DecorationSet): boolean {
  let touched = false
  tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
    if (touched) return
    mapped.between(fromB, toB, () => {
      touched = true
      return false
    })
    if (!touched && tr.state.doc.lineAt(fromB).text.includes('![')) touched = true
    // A freshly-inserted `<video>`/`<audio>` line (like `![` for images) — otherwise
    // an inserted media embed stays raw until the caret happens to enter its line.
    if (!touched && /<(video|audio)\b/i.test(tr.state.doc.lineAt(fromB).text)) touched = true
    if (!touched && (inTableAt(tr.state, fromB) || inTableAt(tr.state, toB))) touched = true
  })
  return touched
}

/** Does the selection sit on (or span) a block whose rendering depends on the
 * selection — an image (`![`) or `<video>`/`<audio>` line (caret reveal), or a
 * table (a caret-leave after inserting/editing raw rows needs to (re)render it)?
 * Used to gate the selection-change rebuild: a cursor move through plain prose can't
 * change any widget, so we keep the mapped set instead of re-scanning the whole
 * syntax tree on every keystroke/arrow. The image/media check scans only the lines
 * the selection touches (a superset of `detectMedia`'s match, so it never misses a
 * reveal); the table check uses the syntax tree (reliable here — selection changes
 * happen after the parser has settled). */
function selectionNearBlock(state: EditorState): boolean {
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from)
    const last = r.to <= first.to ? first : state.doc.lineAt(r.to)
    const text = state.doc.sliceString(first.from, last.to)
    if (text.includes('![') || /<(video|audio)\b/i.test(text)) return true
    if (inTableAt(state, r.from) || inTableAt(state, r.to)) return true
  }
  return false
}

const blocksField = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update: (value, tr) => {
    const mapped = value.map(tr.changes)
    if (tr.docChanged) return touchesBlocks(tr, mapped) ? build(tr.state) : mapped
    // Selection-only change: rebuild ONLY when the caret enters or leaves a
    // reveal-capable block line (before OR after the move). Since this branch is
    // never reached for doc-changing transactions (the docChanged return above wins),
    // startState and state share the same text, so both selections are comparable.
    // No shift → no reload; the rebuild just toggles the image/media source reveal.
    if (tr.selection) {
      return selectionNearBlock(tr.startState) || selectionNearBlock(tr.state)
        ? build(tr.state)
        : mapped
    }
    // Parse-progress: the background parser advanced the tree, so an Image/Table/media
    // Paragraph node absent on the last build may exist now. Rebuild so the block
    // widget appears the moment the parser catches up (instead of staying raw markdown
    // until an unrelated edit). Cheap pointer compare; fires only on the handful of
    // ticks until the parse settles. Must sit AFTER the doc/selection gates (those
    // transactions also change the tree) so this only catches pure parse-progress.
    if (syntaxTree(tr.startState) != syntaxTree(tr.state)) return build(tr.state)
    return mapped
  },
  provide: (f) => EditorView.decorations.from(f),
})

/** The [from, to] of an atomic block widget that FULLY covers `lineNo`, or null. Reads
 * `EditorView.atomicRanges` — the one place every block provider (this field's tables/
 * images/media, plus youtubeCards and mermaidCards) registers — so the guard protects
 * all of them uniformly, not just tables. "Fully covers" (range.from ≤ line.from and
 * range.to ≥ line.to) is what distinguishes a BLOCK widget (spans whole lines) from an
 * INLINE replace (an image mid-paragraph): only a block has a hidden boundary newline a
 * neighbouring backspace could eat, so only a block needs the select-first guard. */
function blockRangeCoveringLine(view: EditorView, lineNo: number): { from: number; to: number } | null {
  const line = view.state.doc.line(lineNo)
  let found: { from: number; to: number } | null = null
  for (const getRanges of view.state.facet(EditorView.atomicRanges)) {
    getRanges(view).between(line.from, line.to, (from, to) => {
      if (from <= line.from && to >= line.to) {
        found = { from, to }
        return false
      }
    })
    if (found) break
  }
  return found
}

/** Backspace at the start of the line right AFTER a block widget (or Delete at the end
 * of the line right BEFORE one): SELECT the whole block instead of eating the hidden
 * boundary newline into the widget's source (which corrupts a table / breaks a card's
 * parse). A second press then deletes the now-selected block. Obsidian's two-step
 * "backspace to select, backspace again to delete" — the canonical way to make a
 * rendered block deletable without exposing its raw source. Generalised across ALL
 * block widgets via `atomicRanges` (tables, images, media, youtube, mermaid). */
function selectAdjacentBlock(view: EditorView, forward: boolean): boolean {
  const { state } = view
  const sel = state.selection.main
  if (!sel.empty) return false // a selection already exists (e.g. the block we just selected) → let the default delete it
  const line = state.doc.lineAt(sel.head)
  let range: { from: number; to: number } | null
  if (forward) {
    if (sel.head !== line.to || line.number >= state.doc.lines) return false
    range = blockRangeCoveringLine(view, line.number + 1)
  } else {
    if (sel.head !== line.from || line.number <= 1) return false
    range = blockRangeCoveringLine(view, line.number - 1)
  }
  if (!range) return false
  view.dispatch({ selection: { anchor: range.from, head: range.to }, userEvent: 'select' })
  return true
}

const blockDeleteGuard = Prec.high(
  keymap.of([
    { key: 'Backspace', run: (v) => selectAdjacentBlock(v, false) },
    { key: 'Delete', run: (v) => selectAdjacentBlock(v, true) },
  ]),
)

export const blocksV2: Extension = [
  blocksField,
  // Treat every block widget's range (table / image / media replace) as an ATOMIC
  // unit for cursor motion and deletion, per the CM decoration guide: arrows skip it
  // instead of landing in hidden source, and a delete that reaches into it removes the
  // whole range at once rather than nibbling invisible characters one at a time.
  EditorView.atomicRanges.of((view) => view.state.field(blocksField)),
  blockDeleteGuard,
]

// Test-only: the selection gate predicate + the field, so the "cursor move through
// prose keeps the mapped set (no rebuild) but a move onto a block line reveals" the
// invariant can be asserted headlessly.
export { selectionNearBlock as _selectionNearBlock, blocksField as _blocksField }
