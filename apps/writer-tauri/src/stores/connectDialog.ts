// Global open/close switch for the Claude OAuth re-connect dialog.
//
// The dialog itself is mounted once (in Sidebar) but can be triggered from
// anywhere — currently the sidebar account menu and the chat error card
// (when a turn fails with code `AUTH`).

import { create } from 'zustand'

interface ConnectDialogStore {
  open: boolean
  setOpen: (v: boolean) => void
}

export const useConnectDialog = create<ConnectDialogStore>((set) => ({
  open: false,
  setOpen: (v) => set({ open: v }),
}))
