// State for the editor's IDE-style status footer.
//
// Single surface today (Phase 3.B removed the mark-hover publisher):
//
//   Doc stats — the AI-vs-human writing ratio for the active doc.
//   Computed on doc change by a small subscriber in EditorFooter
//   (walks the doc, sums chars under proofAuthored marks).
//
// The HoveredMark / setHovered API was retired with the mark hover
// plugin. `stats.aiChars` still reflects historical proofAuthored
// spans because the schema stays around for legacy vault data; new
// content lands without authored marks (no propose_change tool).

import { create } from 'zustand'

/** Active-doc writing-source stats. Recomputed whenever the PM doc
 * version bumps (see docVersionPlugin). 0% AI / 100% human when no
 * doc is open. */
export interface DocStats {
  totalChars: number
  aiChars: number
  wordCount: number
  /** Newest acceptedAt across all proofAuthored marks in the doc,
   * or null when nothing AI-authored has been kept. The display
   * decides whether to render it; this is just the raw fact. */
  lastAcceptedAt: string | null
}

interface EditorFooterState {
  stats: DocStats
  setStats: (s: DocStats) => void
}

export const useEditorFooter = create<EditorFooterState>((set) => ({
  stats: { totalChars: 0, aiChars: 0, wordCount: 0, lastAcceptedAt: null },
  setStats: (s) => set({ stats: s }),
}))
