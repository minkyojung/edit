import { useEffect } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'

/**
 * Mirrors the Tauri window's fullscreen state onto `<body data-fullscreen>`
 * so CSS can collapse the traffic-light reservation in fullscreen — macOS
 * hides the stoplight buttons there, and the 80px gap would otherwise sit
 * empty on the left of the editor header.
 *
 * Also measures the macOS traffic-light close button's vertical center via
 * the Rust `get_traffic_light_y` command and exposes it as the
 * `--traffic-light-center-y` CSS var. Header components derive `--header-h`
 * from this so the HTML chrome stays aligned with the stoplights regardless
 * of macOS version or NSWindowToolbarStyle drift. Re-measured on resize to
 * catch fullscreen exit (the button moves back from offscreen).
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

    const measureTrafficLight = async () => {
      try {
        const y = await invoke<number>('get_traffic_light_y')
        if (cancelled) return
        // 0 = command couldn't measure (non-mac, fullscreen, no window).
        // Leave the previous value in place so we don't clobber a good
        // reading with a transient 0 during fullscreen toggle.
        if (y > 0) {
          document.documentElement.style.setProperty(
            '--traffic-light-center-y',
            `${y}px`,
          )
        }
      } catch {
        // Swallow — CSS fallback (defined in index.css) covers this.
      }
    }

    win.isFullscreen().then(apply).catch(() => apply(false))
    measureTrafficLight()

    const unlistenPromise = win.onResized(() => {
      win.isFullscreen().then(apply).catch(() => {})
      measureTrafficLight()
    })

    return () => {
      cancelled = true
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {})
    }
  }, [])
}
