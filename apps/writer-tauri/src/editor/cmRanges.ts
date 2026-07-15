import { type EditorState } from '@codemirror/state'

/** True when any selection range overlaps or touches [from, to] (inclusive — an
 * edge counts, so a just-typed marker stays "under the caret" until it moves off).
 * Shared by the live-preview reveal gate and the block-widget reveal gate. */
export function cursorInRange(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) {
    if (r.from <= to && from <= r.to) return true
  }
  return false
}
