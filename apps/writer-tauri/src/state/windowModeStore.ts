// The window's display MODE: the normal full window vs. a small Raycast-Notes
// compact panel.
//
// mode is an EXPLICIT USER INTENT, never a function of the window's size. The
// user enters/leaves compact deliberately (⌘⌥C, the Ask-AI action); an ordinary
// resize — dragging an edge, or macOS moving the window to a screen half — must
// NOT change it. So `mode` is written ONLY by setCompact (the sole writer), and
// re-hydrated at boot from the native compact flag (is_window_compact), which
// is the durable truth and survives a webview reload.
//
// setCompact issues the native resize AND records the intent:
//   setCompact(true|false) → set_window_compact → set mode
// The native command owns the geometry (size, min/max, level, full-frame
// stash/restore). The same NSWindow is resized, never recreated, so the
// editor's content (text, cursor, scroll) survives.

import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'

export type WindowMode = 'full' | 'compact'

interface WindowModeState {
  /** The active display mode. Written only via setCompact/toggle; do not set
   * it directly. */
  mode: WindowMode
  /** Enter (true) or leave (false) the compact panel: resize the native window,
   * then record the intent. */
  setCompact: (compact: boolean) => Promise<void>
  /** Flip between full and compact. */
  toggle: () => Promise<void>
}

export const useWindowModeStore = create<WindowModeState>((set, get) => ({
  mode: 'full',
  setCompact: async (compact) => {
    try {
      await invoke('set_window_compact', { compact })
      set({ mode: compact ? 'compact' : 'full' })
    } catch (e) {
      console.error('[window-mode] resize failed', e)
    }
  },
  toggle: async () => {
    await get().setCompact(get().mode !== 'compact')
  },
}))
