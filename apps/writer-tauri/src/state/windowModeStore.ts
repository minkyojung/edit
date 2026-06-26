// Single source of truth for the window's display MODE: the normal full
// window vs. a small Raycast-Notes-style compact panel.
//
// The whole trick to "shrink but keep what I was writing" is that the same
// NSWindow is resized, never recreated — the webview (and the editor's text,
// cursor, scroll) survives. The actual geometry + the smooth animation live
// natively in the `set_window_compact` Rust command; this store only owns the
// `mode` flag that AppShell reads to collapse the sidebar / right panel, and
// the Rust side stashes/restores the full-window frame.
//
// Layout flips first, then the window animates around it: the editor reflows
// to the compact column while the native frame eases down to 420×520.

import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'

export type WindowMode = 'full' | 'compact'

interface WindowModeState {
  mode: WindowMode
  toggle: () => Promise<void>
}

export const useWindowModeStore = create<WindowModeState>((set, get) => ({
  mode: 'full',
  toggle: async () => {
    const prev = get().mode
    const next: WindowMode = prev === 'full' ? 'compact' : 'full'
    set({ mode: next })
    try {
      await invoke('set_window_compact', { compact: next === 'compact' })
    } catch (e) {
      // Native resize rejected — roll the layout back so it doesn't sit
      // compact over a full-size window (or vice versa).
      console.error('[window-mode] resize failed', e)
      set({ mode: prev })
    }
  },
}))
