// Subscribes this window to the Rust update state machine: mirror every
// `updater:state` broadcast into the store (so the About settings row
// renders it) and fire a toast on the meaningful transitions. This is the
// "user driver" half of the canonical pattern — the UI reflects state Rust
// owns; it holds no update logic of its own.
//
// Mounted once per window from App(), so the launcher AND project windows
// each render their own status + toast. The single-checker guarantee (no
// duplicate downloads) lives in Rust's busy flag, not here.

import { useEffect } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { updater, UPDATER_EVENT, type UpdateState } from '@/lib/updater'
import { useUpdateStore } from '@/state/updateStore'
import { useWhatsNewStore } from '@/state/whatsNewStore'
import { showUpdateReadyToast } from '@/components/UpdateReadyToast'
import { armRestartWhenIdle } from '@/lib/restartWhenIdle'
import { openSettings } from '@/settings/useSettingsDialog'
import { notify } from '@/lib/notify'

/** Toast only the two user-facing moments, and only on the transition INTO
 * them (so they don't re-animate). Auto-download is silent — `checking` and
 * `downloading` never toast; the download just happens in the background. */
function reflectToast(prev: UpdateState, next: UpdateState) {
  if (prev.status === next.status) return
  if (next.status === 'ready') {
    const { version, notes } = next
    showUpdateReadyToast({
      version,
      onSeeChanges: () => {
        useWhatsNewStore.getState().pin({
          version,
          notes: notes?.trim() || 'No release notes for this version.',
        })
        openSettings('about')
      },
      onRestartIdle: () => armRestartWhenIdle(),
      onRestart: () => void updater.install(),
    })
  } else if (next.status === 'error') {
    notify.updateFailed(next.phase)
  }
}

export function useUpdaterEvents() {
  useEffect(() => {
    let disposed = false
    let unlisten: UnlistenFn | undefined

    // Seed from the current snapshot (covers a window that mounts after the
    // last broadcast). Seeding does NOT toast — only live transitions do.
    void updater
      .status()
      .then((snapshot) => {
        if (!disposed) useUpdateStore.getState().set(snapshot)
      })
      .catch(() => {})

    void listen<UpdateState>(UPDATER_EVENT, (event) => {
      const prev = useUpdateStore.getState().state
      const next = event.payload
      useUpdateStore.getState().set(next)
      reflectToast(prev, next)
    }).then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])
}
