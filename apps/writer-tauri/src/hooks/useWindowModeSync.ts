// Keeps windowModeStore.mode in sync with the ACTUAL native window size.
//
// mode is in-memory (not persisted), so a webview reload (HMR, a route
// remount, a crash-recover) resets it to 'full' — but the NSWindow keeps the
// compact size we resized it to (that lives natively, not in JS). The result
// is full-size UI rendered inside a compact window. Reconciling against the
// real window width on mount + on every resize makes the window size the
// single source of truth, so the two can't drift.

import { useEffect } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useWindowModeStore, type WindowMode } from '@/state/windowModeStore'

// Logical px. Sits in the gap between the compact max width (600) and the full
// minimum (800), so it classifies cleanly either way.
const COMPACT_WIDTH_THRESHOLD = 700

export function useWindowModeSync() {
  useEffect(() => {
    const win = getCurrentWindow()
    let unlisten: (() => void) | undefined
    let disposed = false

    const setModeForWidth = (logicalWidth: number) => {
      const mode: WindowMode =
        logicalWidth < COMPACT_WIDTH_THRESHOLD ? 'compact' : 'full'
      if (useWindowModeStore.getState().mode !== mode) {
        useWindowModeStore.setState({ mode })
      }
    }

    void (async () => {
      // scaleFactor is stable for the window's lifetime on a given display;
      // cache it so per-resize handling needs no extra IPC.
      const scale = await win.scaleFactor()
      const size = await win.innerSize()
      if (disposed) return
      setModeForWidth(size.width / scale)

      const u = await win.onResized(({ payload }) => {
        setModeForWidth(payload.width / scale)
      })
      if (disposed) u()
      else unlisten = u
    })()

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])
}
