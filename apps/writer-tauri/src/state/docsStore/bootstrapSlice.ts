/**
 * docsStore — bootstrap slice.
 *
 * Owns the single cross-cutting orchestrator: `bootstrap`. Runs once
 * at app launch (via BootGate's `useEffect`) and:
 *   1. Scans the vault → `knownDocs`
 *   2. Ensures today's daily exists in the catalog
 *   3. Validates persisted tab state against the live catalog
 *   4. Force-promotes today's daily into the open strip
 *   5. Eagerly warms the active doc's handle (first paint)
 *   6. Triggers the wikiService ensure-system-pages stub (no-op today)
 *   7. Flips `bootstrapping` false
 *
 * Touches state across nearly every other slice but only through
 * `set` / `get` calls — same surface every slice uses. Module-level
 * `bootstrapInFlight` flag protects against React Strict Mode's
 * intentional double-effect-invocation in dev (pre-flag, ~12 of 14
 * dailies were duplicated).
 */

import { generateClientSlug } from '@/lib/slug'
import { todayLocalDate, writeDocMeta } from '@/hooks/useDocMeta'
import { scanVault } from '@/lib/scanVault'
import { scrubDailyTitleArtifacts } from './handlesSlice'
import type { GetDocsState, KnownDoc, SetDocsState } from './types'

export interface BootstrapSlice {
  /** Set during bootstrap; turns to false when initial restore is done. */
  bootstrapping: boolean
  /** Transient slug for the post-bootstrap URL replace. See DocsState
   * docstring for the lifecycle. */
  bootTargetSlug: string | null
  /** Run the initial vault scan → catalog → tab restore pipeline.
   * Re-entrancy-safe via the module-level `bootstrapInFlight` flag. */
  bootstrap: () => Promise<void>
  /** Consume `bootTargetSlug` (RouteSyncBridge calls this after the
   * replace navigate). */
  clearBootTarget: () => void
}

/** Re-entrancy guard for bootstrap().
 *
 * React Strict Mode intentionally double-invokes effects in dev, so
 * BootGate's `useEffect(() => bootstrap(), [])` fires twice in quick
 * succession. Without a guard, the second call sees the catalog
 * half-built and races to create a duplicate daily — historically
 * 12 of 14 days carried exactly 2 dailies. This module-level flag
 * short-circuits the second call.
 *
 * Module-level (not in store state) so it lives across the store's
 * `set()` updates — a store-state guard would race with the same
 * async window we are trying to protect. try/finally so a thrown
 * bootstrap (network failure during legacy migration etc.) doesn't
 * leave the guard latched and block legitimate later reboots within
 * the same process. */
let bootstrapInFlight = false

export const createBootstrapSlice = (
  set: SetDocsState,
  get: GetDocsState,
): BootstrapSlice => ({
  bootstrapping: true,
  bootTargetSlug: null,

  clearBootTarget: () => set({ bootTargetSlug: null }),

  bootstrap: async () => {
    if (bootstrapInFlight) return
    bootstrapInFlight = true
    try {
      const today = todayLocalDate()

      // Path C: vault folder is the catalog. scanVault walks the
      // active vault, reads each sidecar to recover its slug, and
      // returns a KnownDoc[] that drops straight into the store.
      // No localStorage-persisted knownDocs to reconcile — the
      // vault is single source of truth across restarts.
      //
      // Empty result when no vault is selected (degraded mode —
      // boot still proceeds so the user can see the app and pick
      // a vault from the picker that BootGate auto-triggered).
      const scanned = await scanVault()
      set({ knownDocs: scanned })

      // Make sure today's daily exists in the catalog. If scan
      // found one on disk we reuse its slug; otherwise we mint a
      // new slug here and add it in-memory only. The auto-flush
      // pipeline writes the file (plus sidecar with this slug) on
      // the next 2s tick, so the entry stabilises onto disk
      // without bootstrap having to do disk I/O itself.
      let todaysDaily = scanned.find(
        (d) => d.type === 'daily' && d.date === today,
      )
      if (!todaysDaily) {
        const slug = generateClientSlug()
        const meta: KnownDoc = { slug, type: 'daily', date: today }
        todaysDaily = meta
        set((s) => ({ knownDocs: [...s.knownDocs, meta] }))
      }

      // Validate persisted tab state against the freshly hydrated
      // catalog. Slugs that don't have a backing KnownDoc are
      // dropped — they refer to docs deleted externally between
      // sessions (or remembered from a pre-Path-C build where
      // knownDocs persisted and could diverge from disk).
      const knownSlugs = new Set(get().knownDocs.map((d) => d.slug))
      let openSlugs = get().openSlugs.filter((s) => knownSlugs.has(s))

      // Today's daily is always promoted into the tab strip ("always
      // land on today" is the journal's design promise).
      if (!openSlugs.includes(todaysDaily.slug)) {
        openSlugs = [...openSlugs, todaysDaily.slug]
      }

      // Pick a boot-target slug for RouteSyncBridge's replace navigate.
      // Preference order:
      //   1. The first surviving slug from persisted openSlugs (a doc
      //      the user actually had open last session)
      //   2. Today's daily (always-promoted; the journal floor)
      // This is *not* the active slug — the URL is. We just hand the
      // bridge a sensible target so the first paint isn't a blank
      // "no doc" screen when the user enters via `/`.
      const survivedOpen = openSlugs.find((s) => s !== todaysDaily.slug)
      const bootTargetSlug = survivedOpen ?? todaysDaily.slug

      set({ openSlugs, bootTargetSlug })
      set((s) => ({
        expandedDocSlugs: s.expandedDocSlugs.includes(todaysDaily!.slug)
          ? s.expandedDocSlugs
          : [...s.expandedDocSlugs, todaysDaily!.slug],
      }))

      // Eagerly connect the boot-target slug so first paint shows
      // content. Daily docs get their meta seeded if missing (covers
      // the path where today's daily is brand new and has no meta
      // map yet). The URL may name a different slug — useRouteSync
      // will warm that one on its first tick; the warm here just
      // covers the "URL has no slug, bridge will replace into
      // bootTargetSlug" path so the editor doesn't flash empty.
      const slugToOpen = bootTargetSlug
      if (slugToOpen) {
        await get().ensureHandle(slugToOpen)
        const handle = get().handles[slugToOpen]
        const known = get().knownDocs.find((d) => d.slug === slugToOpen)
        if (handle && known?.type === 'daily' && known.date) {
          const metaMap = handle.ydoc.getMap('meta')
          if (!metaMap.get('type')) {
            writeDocMeta(handle.ydoc, {
              type: 'daily',
              date: known.date,
              createdAt: new Date().toISOString(),
            })
          }
          scrubDailyTitleArtifacts(handle.ydoc)
        }
      }

      // System pages stub — currently a no-op (see wikiService).
      // Kept so a future "ensure conventions / log / index" pass has
      // a wired entry point.
      void import('../wikiService').then(({ ensureWikiDocs }) =>
        ensureWikiDocs(),
      ).catch((err) =>
        console.error('[wiki] bootstrap wiki failed', err),
      )

      // Tier 1 wiki index cache is null on cold boot, but invalidate
      // explicitly so any pre-bootstrap getWikiIndex() call (defensive
      // — no current caller, but easy to add accidentally) doesn't
      // cache a half-built index against an empty catalog.
      void import('../wikiIndex').then(({ invalidateWikiIndex }) =>
        invalidateWikiIndex(),
      ).catch((err) =>
        console.error('[wiki] index invalidate failed', err),
      )

      set({ bootstrapping: false })
    } finally {
      bootstrapInFlight = false
    }
  },
})
