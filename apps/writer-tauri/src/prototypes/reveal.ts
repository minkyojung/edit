// Line-level reveal helper for the v1 block fields (mermaid / youtube cards):
// a card shows its rendered form ⟺ no selection touches its line(s). The inline
// / marker constructs use the edge-inclusive `cursorInRange` predicate in
// `v2/cursorRange` instead.

import type { EditorState } from '@codemirror/state'

/** Line numbers touched by any selection range — a card on one of these lines
 * reveals its raw source (the line-level reveal rule for the v1 block fields). */
export function activeLines(state: EditorState): Set<number> {
  const set = new Set<number>()
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number
    const b = state.doc.lineAt(r.to).number
    for (let n = a; n <= b; n++) set.add(n)
  }
  return set
}
