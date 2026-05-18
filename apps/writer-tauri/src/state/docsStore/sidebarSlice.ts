/**
 * docsStore — sidebar fold state slice.
 *
 * Holds which doc rows in the sidebar tree are currently expanded.
 * Persisted across reloads (see persistConfig) so the user's fold
 * layout survives a restart. Today's daily is force-added during
 * bootstrap so the writing surface always greets them with that
 * day's notes already in view.
 *
 * archive/delete actions in other slices also mutate this field
 * directly (cleaning out slugs that no longer exist) — they reach
 * for it via `set`, not through this slice's action. That's fine;
 * the slice owns the field declaration + the user-driven toggle.
 */

import type { SetDocsState } from './types'

export interface SidebarSlice {
  /** Slugs of docs whose tree row is currently expanded in the
   * sidebar — daily and writing alike. Persisted so the user's
   * fold layout survives a reload. Today's daily is force-added
   * during bootstrap so the writing surface always greets them
   * with their day's notes already in view. */
  expandedDocSlugs: string[]

  /** Toggle the sidebar fold for a given doc. */
  toggleExpanded: (slug: string) => void
}

export const createSidebarSlice = (set: SetDocsState): SidebarSlice => ({
  expandedDocSlugs: [],

  toggleExpanded: (slug) =>
    set((s) => ({
      expandedDocSlugs: s.expandedDocSlugs.includes(slug)
        ? s.expandedDocSlugs.filter((x) => x !== slug)
        : [...s.expandedDocSlugs, slug],
    })),
})
