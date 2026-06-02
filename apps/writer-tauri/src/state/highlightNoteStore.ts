// Drives the inline note popover shown right after a highlight is
// created. SelectionBubble opens it (with the new highlight's id + the
// data needed to mirror into the daily); HighlightNotePopover renders it
// and, on commit, writes the note to the record + appends the daily line.
//
// The daily append lives at COMMIT time (not at highlight-create time) so
// the daily bullet is written once, already carrying the note — no need
// to rewrite an existing line.

import { create } from 'zustand'

export interface HighlightNoteTarget {
  slug: string
  id: string
  quote: string
  /** Article title, for the daily breadcrumb the note nests under. */
  title: string
  /** Viewport coords (fixed positioning) just below the selection end. */
  anchor: { top: number; left: number }
}

interface HighlightNoteState extends Partial<HighlightNoteTarget> {
  open: boolean
  openNote: (t: HighlightNoteTarget) => void
  close: () => void
}

export const useHighlightNoteStore = create<HighlightNoteState>((set) => ({
  open: false,
  openNote: (t) => set({ open: true, ...t }),
  close: () =>
    set({
      open: false,
      slug: undefined,
      id: undefined,
      quote: undefined,
      title: undefined,
      anchor: undefined,
    }),
}))
