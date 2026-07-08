// Open-state for the settings modal. A tiny standalone store (not a local useState)
// so any surface can open settings — the sidebar menu, a future Cmd+, shortcut, the
// command palette — without prop-drilling. The SettingsDialog mounts once at the app
// root and subscribes here (mirrors useImageAltDialogStore).

import { create } from 'zustand'
import type { SettingsCategory } from './SettingsNav'

interface SettingsDialogState {
  open: boolean
  /** Which category pane is shown — also the deep-link target. */
  category: SettingsCategory
  setOpen: (open: boolean) => void
  setCategory: (category: SettingsCategory) => void
}

export const useSettingsDialog = create<SettingsDialogState>((set) => ({
  open: false,
  category: 'appearance',
  setOpen: (open) => set({ open }),
  setCategory: (category) => set({ category }),
}))

/** Open the settings modal from anywhere (non-React callers too), optionally
 * deep-linking to a category. */
export function openSettings(category: SettingsCategory = 'appearance'): void {
  useSettingsDialog.setState({ open: true, category })
}
