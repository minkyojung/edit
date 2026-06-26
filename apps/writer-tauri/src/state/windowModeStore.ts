// Single source of truth for the window's display MODE: the normal full
// window vs. a small Raycast-Notes-style compact panel.
//
// The whole trick to "shrink but keep what I was writing" is that we never
// recreate the window or the webview — `toggle()` only resizes the same
// NSWindow. The editor (CmEditor) stays mounted, so React state, the
// CodeMirror document, cursor and scroll are preserved for free. The layout
// (AppShell) reads `mode` to hide the sidebar / right panel in compact; the
// editor body + its in-body title are all that remain.
//
// Order matters when shrinking: the window's min size (800×600 from
// tauri.conf) would clamp a 420px setSize, so we lower the min FIRST, then
// size, then cap the max. Expanding reverses it and restores the exact bounds
// captured at the moment we entered compact.

import { create } from 'zustand'
import {
  getCurrentWindow,
  LogicalSize,
  PhysicalSize,
  PhysicalPosition,
} from '@tauri-apps/api/window'

export type WindowMode = 'full' | 'compact'

// Compact panel: opening size + the bounds the user may resize within.
const COMPACT_SIZE = { w: 420, h: 520 }
const COMPACT_MIN = { w: 360, h: 440 }
const COMPACT_MAX = { w: 600, h: 760 }
// Full-window minimum — mirrors tauri.conf.json's minWidth/minHeight so we
// restore the same floor when leaving compact.
const FULL_MIN = { w: 800, h: 600 }

interface SavedBounds {
  width: number
  height: number
  x: number
  y: number
}

interface WindowModeState {
  mode: WindowMode
  /** Full-window bounds captured right before entering compact, restored on
   * the way back. Null while in full mode. Physical units (matches the
   * inner-size / outer-position getters used to capture them). */
  saved: SavedBounds | null
  toggle: () => Promise<void>
}

export const useWindowModeStore = create<WindowModeState>((set, get) => ({
  mode: 'full',
  saved: null,
  toggle: async () => {
    const win = getCurrentWindow()
    try {
      if (get().mode === 'full') {
        // Capture where we are so the trip back is exact.
        const size = await win.innerSize()
        const pos = await win.outerPosition()
        // Lower the floor first so the compact size isn't clamped to 800×600.
        await win.setMinSize(new LogicalSize(COMPACT_MIN.w, COMPACT_MIN.h))
        await win.setSize(new LogicalSize(COMPACT_SIZE.w, COMPACT_SIZE.h))
        await win.setMaxSize(new LogicalSize(COMPACT_MAX.w, COMPACT_MAX.h))
        set({
          mode: 'compact',
          saved: { width: size.width, height: size.height, x: pos.x, y: pos.y },
        })
      } else {
        const saved = get().saved
        // Drop the compact cap, raise the floor back to the full minimum,
        // then restore the captured bounds.
        await win.setMaxSize(null)
        await win.setMinSize(new LogicalSize(FULL_MIN.w, FULL_MIN.h))
        if (saved) {
          await win.setSize(new PhysicalSize(saved.width, saved.height))
          await win.setPosition(new PhysicalPosition(saved.x, saved.y))
        }
        set({ mode: 'full', saved: null })
      }
    } catch (e) {
      // A rejected resize (e.g. a missing window capability) shouldn't wedge
      // the UI in a half-applied state — log and leave `mode` untouched.
      console.error('[window-mode] toggle failed', e)
    }
  },
}))
