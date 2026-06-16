// Open-state for the settings modal. A tiny standalone store (not a local useState)
// so any surface can open settings — the sidebar menu, a future Cmd+, shortcut, the
// command palette — without prop-drilling. The SettingsDialog mounts once at the app
// root and subscribes here (mirrors useImageAltDialogStore).

import { create } from 'zustand'

interface SettingsDialogState {
  open: boolean
  setOpen: (open: boolean) => void
}

export const useSettingsDialog = create<SettingsDialogState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))

/** Open the settings modal from anywhere (non-React callers too). */
export function openSettings(): void {
  useSettingsDialog.getState().setOpen(true)
}
