/**
 * docsStore — tab strip slice.
 *
 * Holds the open tab list (no active slug — URL is source of truth)
 * plus three actions that mutate it: `ensureOpen`, `closeDoc`,
 * `reorder`.
 *
 * Persistence: `openSlugs` is persisted across sessions (see
 * persistConfig). Today's daily is force-added during bootstrap so
 * the journal always starts on "now". The "which doc is the user
 * looking at" question is answered by the URL, not by the store —
 * see useActiveSlug.
 *
 * Cross-slice access:
 *   - `get().ensureHandle(slug)` — handlesSlice; lazy-warm a tab's
 *     handle when it's first promoted or after a close moves us to
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

  /** Promote `slug` into the tab strip (if not already there) and
   * warm its collab handle. Does NOT change which doc the user is
   * looking at — that's the URL's job. Callers that want to switch
   * the view should `navigate(buildViewUrl({..., slug}))` and let
   * `useRouteSync` call `ensureOpen` from there. Unknown slugs
   * no-op so a stale UI handle can't corrupt the strip. */
  ensureOpen: (slug: string) => void
  /** Close a tab. Returns the slug the caller should navigate to
   * (the chosen neighbor, or today's daily on empty strip). Null
   * only on the corner case where the strip empties AND the catalog
   * has no today's daily yet — caller may stay put or surface
   * "no doc". */
  closeDoc: (slug: string) => string | null
  /** Replace the openSlugs order — driven by drag-reorder UI. */
  reorder: (slugs: string[]) => void
}

export const createTabsSlice = (
  set: SetDocsState,
  get: GetDocsState,
): TabsSlice => ({
  openSlugs: [],

  ensureOpen: (slug) => {
    // Refuse unknown slugs so a stale UI ref can't corrupt the strip.
    if (!get().knownDocs.some((d) => d.slug === slug)) return
    set((s) => ({
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
    const { openSlugs, handles } = get()
    const next = openSlugs.filter((s) => s !== slug)
    // Pick a sensible neighbor for the next active slug. The caller
    // navigates to whichever slug we return. Same index in the
    // pruned list → falls back to the previous index → null when
    // the strip empties (invariant below may then promote today's
    // daily into openSlugs and we return that instead).
    const idx = openSlugs.indexOf(slug)
    const neighbor: string | null = next[idx] ?? next[idx - 1] ?? null
    // Stop any chat run bound to this slug BEFORE destroying the
    // handle — a late proposal would otherwise try to apply against
    // a slug we've already torn down.
    useChatRuns.getState().abortBySlug(slug)
    const handle = handles[slug]
    if (handle) {
      handle.destroy()
    }
    const nextHandles = { ...handles }
    delete nextHandles[slug]
    const nextStatus = { ...get().status }
    delete nextStatus[slug]
    // Single set: the empty-strip invariant is folded into the same
    // patch via ensureNonEmptyTabStrip, so the UI never flickers
    // through a blank state and there's no async follow-up that can
    // fail and leave the user stuck.
    const patch = ensureNonEmptyTabStrip(get(), {
      openSlugs: next,
      handles: nextHandles,
      status: nextStatus,
    })
    set(patch)
    // If the invariant promoted today's daily, the post-patch
    // openSlugs has exactly that slug at index 0 — use it as the
    // next active. Otherwise stick with the neighbor we computed.
    const postOpen = patch.openSlugs ?? next
    const finalActive = neighbor ?? postOpen[0] ?? null
    if (finalActive && !get().handles[finalActive]) {
      get().ensureHandle(finalActive).catch((err) =>
        console.error('[docs] post-close ensureHandle failed', err),
      )
    }
    return finalActive
  },

  reorder: (slugs) => set({ openSlugs: slugs }),
})
