// Global open switch for the ⌘K command palette. The palette is mounted
// once (App root) but can be opened from anywhere — the ⌘K keyboard
// shortcut and the sidebar search button both drive it through here.

import { create } from 'zustand'

interface CommandPaletteStore {
  open: boolean
  openPalette: () => void
  setOpen: (v: boolean) => void
}

export const useCommandPaletteStore = create<CommandPaletteStore>((set) => ({
  open: false,
  openPalette: () => set({ open: true }),
  setOpen: (v) => set({ open: v }),
}))
