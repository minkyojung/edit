// Global open/close switch for the GitHub connect dialog. Mirrors
// connectDialog.ts (Claude). The dialog is mounted once in Sidebar but
// could be triggered from elsewhere later.

import { create } from 'zustand'

interface ConnectGitHubDialogStore {
  open: boolean
  setOpen: (v: boolean) => void
}

export const useConnectGitHubDialog = create<ConnectGitHubDialogStore>(
  (set) => ({
    open: false,
    setOpen: (v) => set({ open: v }),
  }),
)
