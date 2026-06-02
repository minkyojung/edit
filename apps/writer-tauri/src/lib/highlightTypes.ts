// A persistent user highlight on a saved article. Durable source of
// truth — stored in the article's `.meta.json` sidecar and re-anchored
// to the body on load (the PM `proofHighlight` mark is just its render).
//
// Saved articles are effectively immutable (the user reads, doesn't edit
// them), so anchoring by the quoted text + occurrence index stays valid
// across reloads.

export interface HighlightRecord {
  /** Stable id; also carried on the PM mark's `id` attr. */
  id: string
  /** The exact highlighted text — the anchor used by findTextRange. */
  quote: string
  /** 0-based index among identical `quote` matches in the body, so a
   * phrase that appears more than once re-anchors to the right spot. */
  occurrence: number
  /** Optional user note. Mirrored into the daily note; shown in the
   * hover card. */
  note?: string
  /** ISO creation timestamp. */
  createdAt: string
}
