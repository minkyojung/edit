// Trigger for "create a new folder" inline in the sidebar tree. The
// header button (in Sidebar) flips `creating` on; FolderTree renders a
// pending input row while it's true and flips it off when the user
// commits or cancels. Kept in a store (not local FolderTree state) so
// the header button — which lives outside FolderTree — can start it.

import { create } from 'zustand'

interface NewFolderStore {
  creating: boolean
  start: () => void
  stop: () => void
}

export const useNewFolderStore = create<NewFolderStore>((set) => ({
  creating: false,
  start: () => set({ creating: true }),
  stop: () => set({ creating: false }),
}))
