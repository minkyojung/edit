// The window's display MODE: the normal full window vs. a small Raycast-Notes
// compact panel.
//
// SINGLE SOURCE OF TRUTH = the native window SIZE. `mode` is PURELY DERIVED
// from it by useWindowModeSync (the sole writer), which reads the width on
// mount and on every native resize. Nothing else writes `mode`.
//
// So `toggle()` is a pure intent: it only issues the resize command. The
// resulting size change fires onResized → useWindowModeSync derives the new
// `mode` → the UI (AppShell / EditorHeader / useVibrancy) reflows. One-way:
//   intent → resize → OS event → derived mode → UI
// No optimistic writes, no reconciliation, so the two can't drift.
//
// The same NSWindow is resized, never recreated, so the editor's content
// (text, cursor, scroll) survives. Geometry + full-frame stash/restore live
// natively in the `set_window_compact` Rust command.

import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'

export type WindowMode = 'full' | 'compact'

interface WindowModeState {
  /** Derived from the native window width by useWindowModeSync. Read-only to
   * the rest of the app; do not set it directly. */
  mode: WindowMode
  toggle: () => Promise<void>
}

export const useWindowModeStore = create<WindowModeState>((_set, get) => ({
  mode: 'full',
  toggle: async () => {
    // Intent only: flip the native size. `mode` follows via useWindowModeSync's
    // resize handler — we deliberately don't set it here.
    const compact = get().mode === 'compact'
    try {
      await invoke('set_window_compact', { compact: !compact })
    } catch (e) {
      console.error('[window-mode] resize failed', e)
    }
  },
}))
