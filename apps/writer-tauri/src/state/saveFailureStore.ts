// Tracks per-slug vault-write failures so the app can tell a momentary
// blip (self-heals on the next flush tick — stay silent) apart from a
// persistent problem the user must act on (drive disconnected, disk
// full, permission lost — surface it).
//
// The flush loop (docFileSync) is the only writer: it calls
// `recordFailure` in its catch blocks and `recordSuccess` after a
// successful write. UI (toasts, the quit gate, a future "unsaved" badge)
// reads the selectors. Transient; never persisted.

import { create } from 'zustand'

/** Write-failure cause, classified from the OS error. Drives the copy +
 * the real-world action we ask the user to take. */
export type SaveFailureCause = 'unreachable' | 'disk-full' | 'permission' | 'unknown'

/** Consecutive failures before a slug is considered "persistently"
 * failing. At the 500 ms flush cadence this is ~1.5 s — long enough to
 * ride out a momentary file lock, short enough to warn quickly. */
export const PERSISTENT_THRESHOLD = 3

interface Entry {
  count: number
  cause: SaveFailureCause
}

interface SaveFailureState {
  /** slug → current failure streak. Absent once a write succeeds. */
  failures: Record<string, Entry>
  /** Record one failed write for `slug`. Returns whether the slug just
   * crossed into "persistent" on THIS call (so the caller fires the
   * toast exactly once per streak, not every tick). */
  recordFailure: (slug: string, cause: SaveFailureCause) => { justCrossed: boolean }
  /** Clear a slug's streak after a successful (or no-longer-needed) write. */
  recordSuccess: (slug: string) => void
  /** Any slug currently past the persistence threshold. */
  hasPersistentFailure: () => boolean
  /** The cause of the persistent failures (first one found), for copy. */
  worstCause: () => SaveFailureCause | null
}

export const useSaveFailureStore = create<SaveFailureState>((set, get) => ({
  failures: {},
  recordFailure: (slug, cause) => {
    const prev = get().failures[slug]?.count ?? 0
    const count = prev + 1
    set((s) => ({ failures: { ...s.failures, [slug]: { count, cause } } }))
    return { justCrossed: count === PERSISTENT_THRESHOLD }
  },
  recordSuccess: (slug) => {
    if (!get().failures[slug]) return
    set((s) => {
      const next = { ...s.failures }
      delete next[slug]
      return { failures: next }
    })
  },
  hasPersistentFailure: () =>
    Object.values(get().failures).some((e) => e.count >= PERSISTENT_THRESHOLD),
  worstCause: () => {
    const persistent = Object.values(get().failures).find(
      (e) => e.count >= PERSISTENT_THRESHOLD,
    )
    return persistent?.cause ?? null
  },
}))
