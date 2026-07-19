// Sidebar tag filter — the tag currently used to narrow the note tree.
// Deliberately NOT persisted (unlike sidebar-status-filter): filtering to a
// tag is a transient "let me look at these" action, and restoring it on the
// next launch — with most of the tree hidden — would be more confusing than
// useful. Clicking the active tag again clears it.

import { create } from 'zustand'

interface TagFilterStore {
  activeTag: string | null
  /** Select `tag`, or clear the filter when it's already active. */
  toggleTag: (tag: string) => void
  clear: () => void
}

export const useTagFilterStore = create<TagFilterStore>((set) => ({
  activeTag: null,
  toggleTag: (tag) =>
    set((s) => ({ activeTag: s.activeTag === tag ? null : tag })),
  clear: () => set({ activeTag: null }),
}))
