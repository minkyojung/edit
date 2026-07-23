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
import { toast } from 'sonner'
import { updater, UPDATER_EVENT, type UpdateState } from '@/lib/updater'
import { useUpdateStore } from '@/state/updateStore'
import { useWhatsNewStore } from '@/state/whatsNewStore'
import { showUpdateReadyToast } from '@/components/UpdateReadyToast'
import { armRestartWhenIdle, listenForRestartProbe } from '@/lib/restartWhenIdle'
import { openSettings } from '@/settings/useSettingsDialog'
import { notify } from '@/lib/notify'

/** The "restart to update" prompt. Also fired when seeding a late-mounted
 * window into an already-`ready` state — the prompt is standing state, not a
 * transient notification. Clears any stale failure toast first (the staged
 * update supersedes the failure). */
function showReady(next: Extract<UpdateState, { status: 'ready' }>) {
  const { version, notes } = next
  toast.dismiss('octave-update-failed')
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
}

/** Toast only the user-facing moments, and only on the transition INTO
 * them (so they don't re-animate). Auto-download is silent — `checking` and
 * `downloading` never toast; the download just happens in the background.
 * Errors toast only for MANUAL checks (Sparkle/VS Code convention) —
 * scheduled background failures stay silent, visible in the About row. */
function reflectToast(prev: UpdateState, next: UpdateState) {
  if (prev.status === next.status) return
  if (next.status === 'ready') {
    showReady(next)
  } else if (next.status === 'upToDate') {
    // A successful (manual retry) check clears a stale failure toast.
    toast.dismiss('octave-update-failed')
  } else if (next.status === 'error' && next.origin === 'manual') {
    notify.updateFailed(next.phase)
  }
}

export function useUpdaterEvents() {
  useEffect(() => {
    let disposed = false
    let unlisten: UnlistenFn | undefined

    // Seed from the current snapshot (covers a window that mounts after the
    // last broadcast). Seeding toasts ONLY for `ready` — the standing "restart
    // to update" prompt, so late-opened windows match ones that saw the live
    // transition. Guarded on the pre-seed store state so a live `ready` event
    // that raced ahead of this resolve doesn't double-fire the toast.
    void updater
      .status()
      .then((snapshot) => {
        if (disposed) return
        const prev = useUpdateStore.getState().state
        useUpdateStore.getState().set(snapshot)
        if (snapshot.status === 'ready' && prev.status !== 'ready') showReady(snapshot)
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

    // Answer Rust's pre-restart probe for an armed "restart when idle": if this
    // window has in-flight work, veto so the loop defers to the next lull.
    let unlistenProbe: UnlistenFn | undefined
    void listenForRestartProbe().then((fn) => {
      if (disposed) fn()
      else unlistenProbe = fn
    })

    return () => {
      disposed = true
      unlisten?.()
      unlistenProbe?.()
    }
  }, [])
}
