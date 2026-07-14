/**
 * docsStore — bootstrap slice.
 *
 * Owns the single cross-cutting orchestrator: `bootstrap`. Runs once
 * at app launch (via BootGate's `useEffect`) and:
 *   1. Scans the vault → `knownDocs`
 *   2. Validates persisted tab state against the live catalog
 *   3. Eagerly warms the doc the first paint will render (URL slug,
 *      else a restored tab, else the first doc in the vault)
 *   4. Triggers the wikiService ensure-system-pages stub (no-op today)
 *   5. Flips `bootstrapping` false
 *
 * Touches state across nearly every other slice but only through
 * `set` / `get` calls — same surface every slice uses. Module-level
 * `bootstrapInFlight` flag protects against React Strict Mode's
 * intentional double-effect-invocation in dev (pre-flag, ~12 of 14
 * dailies were duplicated).
 */

import { scanVault } from '@/lib/scanVault'
import { listVaultTreeRecursive } from '@/lib/vault'
import { getActiveSlugFromHash } from '@/lib/viewUrl'
import { pathToKnownSlug } from '@/lib/docPaths'
import { todayLocalDate } from '@/hooks/useDocMeta'
import type { GetDocsState, KnownDoc, SetDocsState } from './types'

/** Deterministic "first doc to open" when neither the restored URL
 * nor a restored tab names one. Order: today's daily → most-recent
 * daily → alphabetically-first live doc. System surfaces (`_system/*`,
 * i.e. index.md / log.md) and archived docs are excluded — they're
 * agent-owned and used to surface at random because scanVault returns
 * files in filesystem order, so `scanned[0]` could be either of them.
 * Mirrors RouteSyncBridge's self-heal target (today's daily) so the
 * eager warm-up and the settled route agree. Null only when the vault
 * holds nothing openable. */
function pickDefaultSlug(scanned: KnownDoc[]): string | null {
  const live = scanned.filter(
    (d) => !d.type.startsWith('system:'),
  )
  const today = todayLocalDate()
  const todaysDaily = live.find((d) => d.type === 'daily' && d.date === today)
  if (todaysDaily) return todaysDaily.slug
  const recentDaily = live
    .filter((d) => d.type === 'daily' && d.date)
    .sort((a, b) => (a.date! < b.date! ? 1 : -1))[0]
  if (recentDaily) return recentDaily.slug
  const firstAlpha = [...live].sort((a, b) => a.slug.localeCompare(b.slug))[0]
  return firstAlpha?.slug ?? null
}

export interface BootstrapSlice {
  /** Set during bootstrap; turns to false when initial restore is done. */
  bootstrapping: boolean
  /** Run the initial vault scan → catalog → tab restore pipeline.
   * Re-entrancy-safe via the module-level `bootstrapInFlight` flag. */
  bootstrap: () => Promise<void>
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

  bootstrap: async () => {
    if (bootstrapInFlight) return
    bootstrapInFlight = true
    try {
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

      // Folder inventory (incl. empty folders) + non-markdown attachments
      // (pdf/png/txt/…) so the sidebar tree can show empty folders and
      // read-only file rows alongside notes. One walk yields both.
      // Best-effort — failure just means they won't appear until next boot.
      try {
        const { dirs, files } = await listVaultTreeRecursive()
        set({ knownFolders: dirs, knownFiles: files })
      } catch (err) {
        console.warn('[boot] tree scan failed', err)
      }

      // Resolve the persisted tab strip (stored as PATHS, since the slug is
      // an ephemeral per-boot handle) back to this boot's fresh slugs against
      // the scanned catalog. Paths with no backing doc — a note deleted or
      // moved-while-closed externally — drop out. Then clear the transient
      // landing field.
      const knownSlugs = new Set(scanned.map((d) => d.slug))
      const openSlugs = get()
        .openPaths.map((path) => pathToKnownSlug(path, scanned))
        .filter((s): s is string => s !== null)
      set({ openSlugs, openPaths: [] })

      // Eagerly connect the slug AppContent will render on first paint.
      // The URL is the source of truth: prefer its slug when it points
      // at a known doc (session restore from main.tsx or a live deep
      // link), else fall back to a restored tab, else a deterministic
      // vault default (pickDefaultSlug — today's daily, never a stray
      // `_system/*` page). Null only when the vault is empty — the app
      // shows an empty state until the user creates / opens a note.
      const urlSlug = getActiveSlugFromHash()
      const slugToOpen =
        urlSlug && knownSlugs.has(urlSlug)
          ? urlSlug
          : openSlugs[0] ?? pickDefaultSlug(scanned)
      if (slugToOpen) {
        await get().ensureHandle(slugToOpen)
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
      // Same for the timeline (the by-date derived view) — invalidating
      // here writes the fresh `_system/timeline.md` on cold boot.
      void import('../vaultTimeline').then(({ invalidateVaultTimeline }) =>
        invalidateVaultTimeline(),
      ).catch((err) =>
        console.error('[wiki] timeline invalidate failed', err),
      )

      set({ bootstrapping: false })
    } finally {
      bootstrapInFlight = false
    }
  },
})
