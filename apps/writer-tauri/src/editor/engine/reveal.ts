// Shared reveal/range vocabulary for the Live Preview decoration providers.
// Single source of truth so every construct (and the mermaid/media block
// fields) applies the SAME predicates instead of re-deriving them. The reveal
// rule is uniform — a construct shows its rendered form ⟺ the selection is NOT
// editing it — but constructs differ in WHICH range they test and whether a
// span selection counts:
//   - inline marks (bold/italic/code/link), image, wikilink → isCursorInRange
//     on the CONSTRUCT range (inclusive: a just-typed marker stays raw).
//   - block constructs (heading/quote/hr/table)             → spansActiveLine
//     on the node's LINE span (line-level reveal).
//   - structural list markers (bullet/task/ordered)         → caretInRange on
//     the MARKER range (COLLAPSED caret only, so Select-All/drag keeps the
//     marker rendered — matches Obsidian).

import type { EditorState } from '@codemirror/state'

/** Selection touches [from, to] (inclusive — touching an edge counts). */
export function isCursorInRange(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) {
    if (r.from <= to && from <= r.to) return true
  }
  return false
}

/** A COLLAPSED caret sits within [from, to] (inclusive). Unlike
 * `isCursorInRange`, a non-empty selection that merely SPANS the range does NOT
 * count — so Select-All or a drag keeps structural list markers rendered (and
 * `user-select:none` keeps them out of the highlight), matching Obsidian. */
export function caretInRange(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) {
    if (r.empty && r.from >= from && r.from <= to) return true
  }
  return false
}

/** Line numbers touched by any selection range — markers on these lines stay
 * raw (the line-level reveal rule for block constructs). Precomputed once per
 * decoration build and passed to `spansActiveLine`. */
export function activeLines(state: EditorState): Set<number> {
  const set = new Set<number>()
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number
    const b = state.doc.lineAt(r.to).number
    for (let n = a; n <= b; n++) set.add(n)
  }
  return set
}

/** True when the node's line span [from, to] intersects any active line. */
export function spansActiveLine(
  state: EditorState,
  from: number,
  to: number,
  active: Set<number>,
): boolean {
  const a = state.doc.lineAt(from).number
  const b = state.doc.lineAt(Math.min(to, state.doc.length)).number
  for (let n = a; n <= b; n++) if (active.has(n)) return true
  return false
}
