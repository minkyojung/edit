import { useEffect } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'

/**
 * Mirrors the Tauri window's fullscreen state onto `<body data-fullscreen>`
 * so CSS can collapse the traffic-light reservation in fullscreen — macOS
 * hides the stoplight buttons there, and the 80px gap would otherwise sit
 * empty on the left of the editor header.
 *
 * Tauri v2 doesn't emit a dedicated fullscreen event, so we re-check
 * `isFullscreen()` on every resize. Cheap (one IPC call) and the resize
 * event already fires on enter/exit.
 */
export function useWindowChrome(): void {
  useEffect(() => {
    let cancelled = false
    const win = getCurrentWindow()

    const apply = (fullscreen: boolean) => {
      if (cancelled) return
      document.body.dataset.fullscreen = fullscreen ? 'true' : 'false'
    }

    win.isFullscreen().then(apply).catch(() => apply(false))

    const unlistenPromise = win.onResized(() => {
      win.isFullscreen().then(apply).catch(() => {})
    })

    return () => {
      cancelled = true
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {})
    }
  }, [])
}
