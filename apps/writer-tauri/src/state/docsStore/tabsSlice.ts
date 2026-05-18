/**
 * docsStore — tab strip slice.
 *
 * Holds the open tab list + the active tab, plus the three actions
 * that mutate them: `setActive`, `closeDoc`, `reorder`.
 *
 * Persistence: `openSlugs` + `activeSlug` are persisted across
 * sessions (see persistConfig). Today's daily is force-added during
 * bootstrap so the journal always starts on "now".
 *
 * Cross-slice access:
 *   - `get().ensureHandle(slug)` — handlesSlice; lazy-warm a tab's
 *     handle when it's first activated or after a close moves us to
 *     a neighbor.
 *
 * Shared helper: `ensureNonEmptyTabStrip` (helpers.ts) — closeDoc
 * uses it to fall back to today's daily when the last open tab is
 * closed. archiveSlice / deleteForever / emptyArchive use the same
 * helper.
 */

import { useChatRuns } from '@/stores/chatRuns'
import { ensureNonEmptyTabStrip } from './helpers'
import type { GetDocsState, SetDocsState } from './types'

export interface TabsSlice {
  /** Slugs currently in the tab strip, in user-visible order.
   * Persisted. */
  openSlugs: string[]
  /** Slug of the tab the editor is currently showing. Persisted. */
  activeSlug: string | null

  /** Bring `slug` to the foreground. Promotes it into the tab strip
   * if it isn't already a tab (e.g. a sidebar wiki entry that's
   * never been opened). Unknown slugs no-op. */
  setActive: (slug: string) => void
  /** Close a tab. Picks a neighbor as the new active tab; falls back
   * to today's daily via {@link ensureNonEmptyTabStrip} when the
   * close empties the strip. */
  closeDoc: (slug: string) => void
  /** Replace the openSlugs order — driven by drag-reorder UI. */
  reorder: (slugs: string[]) => void
}

export const createTabsSlice = (
  set: SetDocsState,
  get: GetDocsState,
): TabsSlice => ({
  openSlugs: [],
  activeSlug: null,

  setActive: (slug) => {
    // Bring any known doc to the foreground. If it isn't yet a tab
    // (e.g. wiki entries that live in the catalog without ever
    // having been opened), promote it to one. Unknown slugs no-op
    // so a stale UI handle can't corrupt activeSlug.
    if (!get().knownDocs.some((d) => d.slug === slug)) return
    set((s) => ({
      activeSlug: slug,
      openSlugs: s.openSlugs.includes(slug)
        ? s.openSlugs
        : [...s.openSlugs, slug],
    }))
    // Lazy-create the handle if this tab hasn't been touched yet.
    if (!get().handles[slug]) {
      get().ensureHandle(slug).catch((err) =>
        console.error('[docs] ensureHandle failed', err),
      )
    }
  },

  closeDoc: (slug) => {
    const { openSlugs, activeSlug, handles } = get()
    const next = openSlugs.filter((s) => s !== slug)
    let nextActive = activeSlug
    if (activeSlug === slug) {
      // Pick a sensible neighbor for the new active tab.
      const idx = openSlugs.indexOf(slug)
      nextActive = next[idx] ?? next[idx - 1] ?? null
    }
    // Stop any chat run bound to this slug BEFORE destroying the
    // ydoc — a late proposal would otherwise try to apply against a
    // slug we've already torn down.
    useChatRuns.getState().abortBySlug(slug)
    const handle = handles[slug]
    if (handle) {
      handle.ydoc.destroy()
    }
    const nextHandles = { ...handles }
    delete nextHandles[slug]
    const nextStatus = { ...get().status }
    delete nextStatus[slug]
    // Single set: the empty-strip invariant is folded into the same
    // patch via ensureNonEmptyTabStrip, so the UI never flickers
    // through a blank state and there's no async follow-up that can
    // fail and leave the user stuck.
    set(ensureNonEmptyTabStrip(get(), {
      openSlugs: next,
      activeSlug: nextActive,
      handles: nextHandles,
      status: nextStatus,
    }))
    // Warm the new active slug's handle if it isn't loaded yet —
    // applies whether the invariant kicked in (today's daily) or we
    // just shifted to a neighbor.
    const finalActive = get().activeSlug
    if (finalActive && !get().handles[finalActive]) {
      get().ensureHandle(finalActive).catch((err) =>
        console.error('[docs] post-close ensureHandle failed', err),
      )
    }
  },

  reorder: (slugs) => set({ openSlugs: slugs }),
})
