// Cross-component signal for "show these release notes in the sidebar card".
// The update-ready toast's "See changes" pins the INCOMING version's notes
// here (from the update manifest); WhatsNewSidebar renders them. Non-persisted
// runtime state — it's a transient UI request, not a preference.

import { create } from 'zustand'

interface PinnedNotes {
  version: string
  notes: string
}

interface WhatsNewStore {
  pinned: PinnedNotes | null
  pin: (p: PinnedNotes) => void
  clear: () => void
}

export const useWhatsNewStore = create<WhatsNewStore>((set) => ({
  pinned: null,
  pin: (pinned) => set({ pinned }),
  clear: () => set({ pinned: null }),
}))
