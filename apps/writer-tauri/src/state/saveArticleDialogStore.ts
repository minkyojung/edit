// Open-state for the Save-to-Read-Later dialog. A tiny store (mirrors
// imageAltDialogStore) so the Command Palette can trigger the dialog
// mounted at the app root without prop-drilling.

import { create } from 'zustand'

interface SaveArticleDialogState {
  open: boolean
  openDialog: () => void
  close: () => void
}

export const useSaveArticleDialogStore = create<SaveArticleDialogState>((set) => ({
  open: false,
  openDialog: () => set({ open: true }),
  close: () => set({ open: false }),
}))
