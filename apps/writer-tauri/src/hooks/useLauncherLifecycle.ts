// When the last project window closes, bring the launcher back so the user
// doesn't end up with no visible window. Runs only in project windows
// (WINDOW_ROOT !== null); the launcher window itself skips this entirely.

import { useEffect } from 'react'
import { getAllWebviewWindows, getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { WINDOW_ROOT } from '@/lib/windowRoot'
import { LAUNCHER_LABEL } from '@/lib/projectWindow'

export function useLauncherLifecycle() {
  useEffect(() => {
    if (!WINDOW_ROOT) return

    const current = getCurrentWebviewWindow()
    let unlisten: (() => void) | undefined

    void current.onCloseRequested(async () => {
      const all = await getAllWebviewWindows()
      const otherProjects = all.filter(
        (w) => w.label !== current.label && w.label.startsWith('project-'),
      )
      if (otherProjects.length === 0) {
        const launcher = all.find((w) => w.label === LAUNCHER_LABEL)
        if (launcher) {
          await launcher.show()
          await launcher.setFocus()
        }
      }
    }).then((fn) => {
      unlisten = fn
    })

    return () => {
      unlisten?.()
    }
  }, [])
}
