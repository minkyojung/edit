// Shared "leave this as RAW text" ranges for the Cursor-style in-buffer review
// (Option B). A pending AI proposal lives as real buffer text so editing it is
// fully native — but it must NOT be live-previewed (rendered), or a proposed
// table/heading/`**bold**` would render as the real thing and you couldn't tell
// proposal from content. Every block/inline renderer reads `inProofRawRange()`
// and skips nodes inside these ranges, so the proposal shows verbatim.
//
// The review layer PROVIDES its ranges through a facet (derived live from its own
// state), so there's no second field to keep in sync.

import { Facet, type EditorState } from '@codemirror/state'

export type RawRange = { from: number; to: number }

// The in-buffer review provides its raw ranges here (red + green of every pending
// proposal). A provider returns the ranges to leave RAW for the current state.
export const proofRawRangeProvider = Facet.define<(state: EditorState) => RawRange[]>()

/** True when `pos` sits inside a range that must stay RAW (a pending proposal).
 * Renderers call this at the top of their node-enter callback and `return false`
 * to skip rendering there. Cheap no-op when there are no pending proposals. */
export function inProofRawRange(state: EditorState, pos: number): boolean {
  for (const provide of state.facet(proofRawRangeProvider)) {
    for (const r of provide(state)) if (pos >= r.from && pos < r.to) return true
  }
  return false
}
