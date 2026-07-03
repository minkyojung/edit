// Deterministic close for editor (project) windows.
//
// macOS-native model: closing a window just CLOSES it — it doesn't quit the
// app and doesn't pop the launcher back up. The app stays alive with no
// windows; re-activating it (dock click → Rust RunEvent::Reopen) reveals the
// launcher. So this handler only flushes, optionally confirms, and destroys.
//
//   preventDefault → flush → confirm if streaming → destroy (always runs)
//
// preventDefault stops Tauri's implicit destroy so the close happens exactly
// once, on our terms; the destroy is unconditional so a stuck-open window
// (the old bug) can't happen. Editor windows only (WINDOW_ROOT set).

import { useEffect } from 'react'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { WINDOW_ROOT } from '@/lib/windowRoot'
import { useChatActivity } from '@/stores/chatActivity'
import { useCloseConfirmStore } from '@/state/closeConfirmStore'
import { flushDirty } from '@/lib/docFileSync'

export function useWindowClose() {
  useEffect(() => {
    if (!WINDOW_ROOT) return // editor windows only; launcher has its own path

    const current = getCurrentWebviewWindow()
    let unlisten: (() => void) | undefined

    void current
      .onCloseRequested(async (event) => {
        // Take control: with preventDefault set, Tauri's wrapper won't
        // auto-destroy, so the close happens exactly once, on our terms.
        event.preventDefault()

        // Always flush pending vault writes before closing.
        await flushDirty().catch(() => {})

        // Confirm only if this window has chats in flight.
        const active = useChatActivity.getState().activeCount
        if (active > 0) {
          const proceed = await useCloseConfirmStore
            .getState()
            .confirmClose(active)
          if (!proceed) return // keep the window open
        }

        // Just close this window. The launcher is NOT shown here — the app
        // stays alive windowless and reveals the launcher on reopen (dock
        // click), the macOS-native behavior.
        await current
          .destroy()
          .catch((e) => console.warn('[close] destroy failed', e))
      })
      .then((fn) => {
        unlisten = fn
      })

    return () => {
      unlisten?.()
    }
  }, [])
}
