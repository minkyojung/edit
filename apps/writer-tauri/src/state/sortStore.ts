// Sidebar tree sort order. Persisted so the user's choice survives a
// restart. Folders are always grouped before files (Obsidian-style); the
// mode decides the ordering WITHIN each group. `created-*` modes fall
// back to a name compare for docs lacking a `createdAt` (legacy notes)
// and for folders (which carry no timestamp). "Modified time" isn't
// offered — the catalog doesn't track an mtime, so it'd need a scan-side
// change to add one.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type SortMode = 'name-asc' | 'name-desc' | 'created-desc' | 'created-asc'

/** Label for each mode, shown in the sidebar sort menu. */
export const SORT_LABELS: Record<SortMode, string> = {
  'name-asc': 'Name (A → Z)',
  'name-desc': 'Name (Z → A)',
  'created-desc': 'Created (newest first)',
  'created-asc': 'Created (oldest first)',
}

interface SortStore {
  mode: SortMode
  setMode: (mode: SortMode) => void
}

export const useSortStore = create<SortStore>()(
  persist(
    (set) => ({
      mode: 'name-asc',
      setMode: (mode) => set({ mode }),
    }),
    { name: 'sidebar-sort', version: 1 },
  ),
)
