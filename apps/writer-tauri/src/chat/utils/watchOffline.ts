/** Wraps the `window` offline event so a run can react to the OS reporting
 * lost network. Returns:
 *  - `aborted` — flag the catch path reads to distinguish offline-induced
 *    AbortError from a user-pressed Stop (the former gets a NETWORK error
 *    card, the latter the muted "Stopped" card).
 *  - `dispose()` — removes the listener; call from finally so a single run
 *    doesn't leak its handler into the next one. */
export interface OfflineWatcher {
  /** True after the offline event has fired at least once during the run. */
  readonly aborted: boolean
  dispose: () => void
}

export function watchOffline(onOffline: () => void): OfflineWatcher {
  let aborted = false
  const handler = () => {
    aborted = true
    onOffline()
  }
  window.addEventListener('offline', handler)
  return {
    get aborted() {
      return aborted
    },
    dispose() {
      window.removeEventListener('offline', handler)
    },
  }
}
