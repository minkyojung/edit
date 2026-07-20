// Sidebar "show only in-progress" filter. Persisted so the user's choice
// survives a restart. When on, the folder tree is narrowed to in-progress
// notes (plus the ancestors needed to keep them reachable) — see FolderTree.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface StatusFilterStore {
  inProgressOnly: boolean
  setInProgressOnly: (on: boolean) => void
}

export const useStatusFilterStore = create<StatusFilterStore>()(
  persist(
    (set) => ({
      inProgressOnly: false,
      setInProgressOnly: (inProgressOnly) => set({ inProgressOnly }),
    }),
    { name: 'sidebar-status-filter', version: 1 },
  ),
)
