// ⌘⌥C toggles the compact (Raycast Notes) panel.
//
// Uses e.code (physical KeyC), NOT e.key: on macOS, holding Option rewrites
// e.key ('c' → 'ç'), so key-based matching would miss. Capture phase so the
// editor / chat input can't swallow it — toggling the window is a global
// action that should win over local text handling.

import { useEffect } from 'react'
import { useWindowModeStore } from '@/state/windowModeStore'

export function useCompactShortcut() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey || !e.altKey || e.shiftKey || e.ctrlKey) return
      if (e.code !== 'KeyC') return
      e.preventDefault()
      void useWindowModeStore.getState().toggle()
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [])
}
