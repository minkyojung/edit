import { type EditorState } from '@codemirror/state'

/** Does any selection range touch [from, to] (inclusive — an edge counts, so a
 * just-typed marker stays raw until the caret moves off)? Shared by the inline
 * (livePreview) and block (blocks) decoration layers so the reveal predicate is
 * defined once and can't drift between them. */
export function cursorInRange(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) {
    if (r.from <= to && from <= r.to) return true
  }
  return false
}
