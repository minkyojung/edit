// Shared "leave this as RAW text" ranges for the Cursor-style in-buffer review
// (Option B). A pending AI proposal lives as real buffer text so editing it is
// fully native — but it must NOT be live-previewed (rendered), or a proposed
// table/heading/`**bold**` would render as the real thing and you couldn't tell
// proposal from content. Every block/inline renderer must consult
// `proofRawOverlap()` / `touchesProofRawRange()` before decorating a span, so the
// proposal shows verbatim. (This used to say "every renderer reads
// inProofRawRange()" while four call sites did not — the cards and this module's
// own two regex passes. Participation is now checked at the point of decoration
// rather than left to convention.)
//
// The review layer PROVIDES its ranges through a facet (derived live from its own
// state), so there's no second field to keep in sync.

import { Facet, type EditorState } from '@codemirror/state'

export type RawRange = { from: number; to: number }

// The in-buffer review provides its raw ranges here (red + green of every pending
// proposal). A provider returns the ranges to leave RAW for the current state.
export const proofRawRangeProvider = Facet.define<(state: EditorState) => RawRange[]>()

/** How a span `[from, to)` sits against the pending-proposal ranges.
 *
 *  • `'inside'`  — entirely within one raw range. Nothing under it can render
 *                  either, so the caller may skip the whole subtree.
 *  • `'partial'` — intersects a raw range without being contained. The caller
 *                  must NOT render this construct (part of its text is proposal,
 *                  and rendering it would hide the diff inside a replace) but it
 *                  MUST still descend, so children clear of the proposal render.
 *  • `'none'`    — clear of every proposal; render normally.
 *
 * Ranges are half-open, so a span starting exactly at a range's end is outside it.
 */
export type ProofRawOverlap = 'none' | 'partial' | 'inside'

/** Classify a span against the pending proposals. Cheap no-op (`'none'`) when
 * there are none.
 *
 * This replaced a point test on `node.from`, which was wrong twice over. It said
 * "inside" for the root `Document` node — whose `from` is always 0 — so a proposal
 * touching position 0 aborted an entire decoration walk and blanked the document.
 * And it said "outside" for a construct a proposal only partly covers, so a
 * proposal over two rows of a table left the table rendered as a block widget
 * built from text containing the proposal, with the accept/reject buttons sealed
 * inside that replace — unreachable. */
export function proofRawOverlap(state: EditorState, from: number, to: number): ProofRawOverlap {
  let partial = false
  for (const provide of state.facet(proofRawRangeProvider)) {
    for (const r of provide(state)) {
      if (from >= r.from && from < r.to && to <= r.to) return 'inside'
      if (from < r.to && to > r.from) partial = true
    }
  }
  return partial ? 'partial' : 'none'
}

/** True when any part of `[from, to)` is proposal text. For renderers that
 * replace a whole block and so have no "descend into children" option — a card
 * either takes the range or leaves it raw. */
export function touchesProofRawRange(state: EditorState, from: number, to: number): boolean {
  return proofRawOverlap(state, from, to) !== 'none'
}

function rawRangesOf(state: EditorState): RawRange[] {
  const out: RawRange[] = []
  for (const provide of state.facet(proofRawRangeProvider)) out.push(...provide(state))
  return out
}

/** Did the pending proposals themselves change across this transaction?
 *
 * Block renderers keep a position-mapped decoration set and only re-walk the tree
 * when a gate says the outcome could differ — doc change, selection move, parse
 * progress. Raw ranges are a FOURTH input to that outcome and are not implied by
 * any of the three: rejecting a proposal is dispatched as an effect-only
 * transaction, so without this the card/table it was suppressing would stay raw
 * until some unrelated edit happened to trigger a rebuild.
 *
 * Cheap: with no proposals open both sides are empty and this is an early false. */
export function proofRawRangesChanged(before: EditorState, after: EditorState): boolean {
  const a = rawRangesOf(before)
  const b = rawRangesOf(after)
  if (a.length !== b.length) return true
  for (let i = 0; i < a.length; i++) if (a[i].from !== b[i].from || a[i].to !== b[i].to) return true
  return false
}
