// Keeps windowModeStore.mode in sync with the ACTUAL native window size.
//
// mode is derived state (not persisted): a webview reload resets it to 'full'
// while the NSWindow keeps its compact size, which would render full-size UI in
// a compact window. Deriving mode from the real window width — once before the
// UI paints (resolveWindowMode, called by BootGate) and on every resize (the
// hook) — makes the window size the single source of truth, so the two can't
// drift AND the first paint is already in the right mode (no full→compact
// flash on reload).

import { useEffect } from 'react'
import { getCurrentWindow, type Window } from '@tauri-apps/api/window'
import { useWindowModeStore, type WindowMode } from '@/state/windowModeStore'

// Logical px. Sits in the gap between the compact max width (600) and the full
// minimum (800), so it classifies cleanly either way.
const COMPACT_WIDTH_THRESHOLD = 700

function setModeForWidth(logicalWidth: number) {
  const mode: WindowMode =
    logicalWidth < COMPACT_WIDTH_THRESHOLD ? 'compact' : 'full'
  if (useWindowModeStore.getState().mode !== mode) {
    useWindowModeStore.setState({ mode })
  }
}

async function readAndApply(win: Window): Promise<number> {
  // scaleFactor is stable for the window's lifetime on a given display.
  const scale = await win.scaleFactor()
  const size = await win.innerSize()
  setModeForWidth(size.width / scale)
  return scale
}

/** One-shot: read the current window size and set mode. Awaited by BootGate
 * BEFORE the app UI renders, so the first paint is already in the correct mode
 * (kills the reload flash). Best-effort — a failure just leaves the default. */
export async function resolveWindowMode(): Promise<void> {
  await readAndApply(getCurrentWindow()).catch(() => {})
}

export function useWindowModeSync() {
  useEffect(() => {
    const win = getCurrentWindow()
    let unlisten: (() => void) | undefined
    let disposed = false

    void (async () => {
      const scale = await readAndApply(win).catch(() => 1)
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
