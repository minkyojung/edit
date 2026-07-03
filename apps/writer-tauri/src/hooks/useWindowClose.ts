// Deterministic close for editor (project) windows.
//
// macOS-native model: closing a window just CLOSES it — it doesn't quit the
// app. To "resume where you left off", the LAST editor window is HIDDEN rather
// than destroyed, so its full live state (scroll, cursor, unsaved buffer) is
// preserved; re-activating the app (dock click → Rust RunEvent::Reopen) shows
// it straight back. Any non-last window really destroys (you still have others).
//
//   preventDefault → flush → confirm if streaming → hide (if last) | destroy
//
// preventDefault stops Tauri's implicit destroy so the close happens exactly
// once, on our terms. Editor windows only (WINDOW_ROOT set).

import { useEffect } from 'react'
import {
  getAllWebviewWindows,
  getCurrentWebviewWindow,
} from '@tauri-apps/api/webviewWindow'
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

        // Last editor window → HIDE it so reopen resumes this exact note
        // (state preserved). Otherwise really destroy it (other windows
        // remain). Guarded so a failure can't strand a half-closed window.
        try {
          const all = await getAllWebviewWindows()
          const others = all.filter(
            (w) => w.label !== current.label && w.label.startsWith('project-'),
          )
          if (others.length === 0) {
            await current.hide()
          } else {
            await current.destroy()
          }
        } catch (e) {
          console.warn('[close] close failed', e)
          await current.destroy().catch(() => {})
        }
      })
      .then((fn) => {
        unlisten = fn
      })

    return () => {
      unlisten?.()
    }
  }, [])
}
