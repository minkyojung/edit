// State for the editor's IDE-style status footer.
//
// Two surfaces feed the footer:
//
//   1. Mark hover — the editor's mark-hover plugin pushes the current
//      hovered mark's metadata here as the cursor moves over a
//      proofProvenance / proofSuggestion / proofComment span. The
//      footer renders source / kind / quote info while it's set.
//
//   2. Doc stats — the AI-vs-human writing ratio for the active doc.
//      Computed on doc change by a small subscriber in
//      EditorFooter (walks the doc, sums chars under proofProvenance
//      marks). Lives here so the footer's two states (hover vs
//      default) read from one place.

import { create } from 'zustand'

export type HoveredMarkKind = 'provenance' | 'suggestion' | 'comment'

/** Shape pushed by the mark-hover plugin. Strings are extracted from
 * the rendered DOM attributes the mark schemas set in toDOM — we
 * don't reach back into PM for this; the DOM is the contract. */
export interface HoveredMark {
  kind: HoveredMarkKind
  /** Mark id (proofSuggestion / proofComment) — used by callers that
   * may want to navigate to the mark. Provenance marks may or may
   * not carry one. */
  id: string | null
  sourceLabel: string | null
  sourceSlug: string | null
  acceptedAt: string | null
  proposedAt: string | null
  model: string | null
  /** suggestionType (replace / insert / delete) for suggestions;
   * undefined otherwise. */
  suggestionType: string | null
  /** Comment text (first ~60 chars, raw) — only set for kind === 'comment'. */
  commentText: string | null
}

/** Active-doc writing-source stats. Recomputed whenever the PM doc
 * version bumps (see docVersionPlugin). 0% AI / 100% human when no
 * doc is open. */
export interface DocStats {
  totalChars: number
  aiChars: number
}

interface EditorFooterState {
  hovered: HoveredMark | null
  stats: DocStats
  setHovered: (m: HoveredMark | null) => void
  setStats: (s: DocStats) => void
}

export const useEditorFooter = create<EditorFooterState>((set) => ({
  hovered: null,
  stats: { totalChars: 0, aiChars: 0 },
  setHovered: (m) => set({ hovered: m }),
  setStats: (s) => set({ stats: s }),
}))
