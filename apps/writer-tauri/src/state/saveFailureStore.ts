// Tracks per-slug vault-write failures so the app can tell a momentary
// blip (self-heals on the next flush tick — stay silent) apart from a
// persistent problem the user must act on (drive disconnected, disk
// full, permission lost — surface it).
//
// The flush loop (docFileSync) is the only writer: it calls
// `recordFailure` in its catch blocks, then `reconcile(dirtySlugs)` once
// at the end of every pass to drop slugs that left the dirty set (saved,
// deleted, archived, …). Keeping `failures ⊆ dirty` as an invariant means
// a recovered or removed slug can never strand a stale entry — the single
// cleanup path replaces per-branch success bookkeeping. UI (the
// save-failure toast, the quit gate, a future "unsaved" badge) reads the
// selectors. Transient; never persisted.

import { create } from 'zustand'

/** Write-failure cause, classified from the OS error. Drives the copy +
 * the real-world action we ask the user to take. */
export type SaveFailureCause = 'unreachable' | 'disk-full' | 'permission' | 'unknown'

/** Consecutive failures before a slug is considered "persistently"
 * failing. At the 500 ms flush cadence this is ~1.5 s — long enough to
 * ride out a momentary file lock, short enough to warn quickly. */
export const PERSISTENT_THRESHOLD = 3

/** When several slugs fail at once with different causes, the single
 * collapsed toast shows the most actionable one (most-actionable first). */
const CAUSE_PRIORITY: SaveFailureCause[] = ['permission', 'disk-full', 'unreachable', 'unknown']

interface Entry {
  count: number
  cause: SaveFailureCause
}

interface SaveFailureState {
  /** slug → current failure streak. Pruned once the slug leaves the dirty set. */
  failures: Record<string, Entry>
  /** Record one failed write for `slug` (increments its streak). Surfacing
   * is decided declaratively by the toast reconciler in docFileSync — this
   * only mutates state. */
  recordFailure: (slug: string, cause: SaveFailureCause) => void
  /** Drop every tracked slug that is no longer in the dirty set. The single
   * cleanup path (saved / deleted / archived / handle-torn-down all clear
   * dirty), called once per flush pass so the store never outlives the
   * condition it describes. No-op — and no state change — when nothing left. */
  reconcile: (dirtySlugs: string[]) => void
  /** Any slug currently past the persistence threshold. */
  hasPersistentFailure: () => boolean
  /** How many slugs have a write actively failing (any streak length).
   * The quit/close data-loss gate keys off THIS, not the raw dirty set: a
   * slug also stays dirty for benign reasons (an unresolved external-edit
   * conflict, a not-yet-ready view, a deferred stale-path write), and none
   * of those are edits the user is about to lose to a broken disk. */
  failingSlugCount: () => number
  /** Highest-priority cause among the persistent failures (drives the
   * collapsed toast copy), or null when nothing is persistently failing. */
  worstCause: () => SaveFailureCause | null
}

export const useSaveFailureStore = create<SaveFailureState>((set, get) => ({
  failures: {},
  recordFailure: (slug, cause) => {
    const count = (get().failures[slug]?.count ?? 0) + 1
    set((s) => ({ failures: { ...s.failures, [slug]: { count, cause } } }))
  },
  reconcile: (dirtySlugs) => {
    const dirty = new Set(dirtySlugs)
    const stale = Object.keys(get().failures).filter((slug) => !dirty.has(slug))
    if (stale.length === 0) return
    set((s) => {
      const next = { ...s.failures }
      for (const slug of stale) delete next[slug]
      return { failures: next }
    })
  },
  hasPersistentFailure: () =>
    Object.values(get().failures).some((e) => e.count >= PERSISTENT_THRESHOLD),
  failingSlugCount: () => Object.keys(get().failures).length,
  worstCause: () => {
    const persistent = Object.values(get().failures).filter(
      (e) => e.count >= PERSISTENT_THRESHOLD,
    )
    if (persistent.length === 0) return null
    return CAUSE_PRIORITY.find((c) => persistent.some((e) => e.cause === c)) ?? 'unknown'
  },
}))
