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
 * Cheap no-op when there are no pending proposals. */
export function inProofRawRange(state: EditorState, pos: number): boolean {
  for (const provide of state.facet(proofRawRangeProvider)) {
    for (const r of provide(state)) if (pos >= r.from && pos < r.to) return true
  }
  return false
}

/** True when the node span `[from, to)` sits ENTIRELY inside a raw range.
 *
 * Renderers call this at the top of their node-enter callback and `return false`
 * to skip the node + its children. It must be CONTAINMENT, not a point test on
 * `node.from`: `Tree.iterate` always enters the root `Document` node first, and
 * `Document.from` is 0 — so a point test made any proposal touching position 0
 * abort the ENTIRE walk, and the whole document lost its live-preview and block
 * decorations. A container node that merely OVERLAPS a proposal has to be
 * descended into so its children can be judged one by one.
 *
 * `from < r.to` keeps the old half-open semantics: a node starting exactly at a
 * range's end is outside it. */
export function nodeInProofRawRange(state: EditorState, from: number, to: number): boolean {
  for (const provide of state.facet(proofRawRangeProvider)) {
    for (const r of provide(state)) if (from >= r.from && from < r.to && to <= r.to) return true
  }
  return false
}
