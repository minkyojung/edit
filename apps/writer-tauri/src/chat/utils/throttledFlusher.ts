/** Coalesces a series of `schedule()` calls into one debounced run of `fn`.
 * The first call sets a timer; further calls during the delay are no-ops
 * (so the work runs at most once per `intervalMs`). `cancel()` clears any
 * pending run — used at commit time so a final synchronous flush isn't
 * shadowed by a stale timer firing right after. */
export interface ThrottledFlusher {
  schedule: () => void
  cancel: () => void
}

export function createThrottledFlusher(intervalMs: number, fn: () => void): ThrottledFlusher {
  let pending: number | null = null
  return {
    schedule() {
      if (pending != null) return
      pending = window.setTimeout(() => {
        pending = null
        fn()
      }, intervalMs)
    },
    cancel() {
      if (pending == null) return
      clearTimeout(pending)
      pending = null
    },
  }
}
