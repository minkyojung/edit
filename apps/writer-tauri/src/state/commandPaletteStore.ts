// Global open switch for the ⌘K command palette. The palette is mounted
// once (App root) but can be opened from anywhere — the ⌘K / ⌘G keyboard
// shortcuts and the sidebar search button both drive it through here.

import { create } from 'zustand'

export type CommandPaletteMode = 'any' | 'date'

interface CommandPaletteStore {
  open: boolean
  mode: CommandPaletteMode
  /** Open the palette in the given mode (defaults to free search). */
  openPalette: (mode?: CommandPaletteMode) => void
  setOpen: (v: boolean) => void
}

export const useCommandPaletteStore = create<CommandPaletteStore>((set) => ({
  open: false,
  mode: 'any',
  openPalette: (mode = 'any') => set({ open: true, mode }),
  setOpen: (v) => set({ open: v }),
}))
