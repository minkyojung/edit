/**
 * docsStore — persist middleware config.
 *
 * What's persisted: only the tab strip state (openSlugs) + the
 * sidebar fold state (expandedDocSlugs). Everything else is
 * runtime-only — `knownDocs` rebuilds from `scanVault()` on every
 * boot (Path C), and `handles`/`status` are by definition session-
 * scoped Y.Doc instances.
 *
 * Why activeSlug is NOT persisted (v6 → v7): the URL is the source
 * of truth for "which doc is open". Persisting an activeSlug field
 * alongside the URL would create the same two-source drift the
 * 3-step migration set out to eliminate. Bootstrap re-derives the
 * post-rehydrate active slug from the URL or a today's-daily
 * fallback; see bootstrapSlice + RouteSyncBridge.
 *
 * Why knownDocs is NOT persisted: pre-Path-C, two catalogs (vault
 * + localStorage) drifted apart and required title-mirror + backfill
 * machinery to reconcile. Single source of truth (vault) eliminates
 * that class of bugs.
 *
 * Migration chain v1 → v7: documented inline. Each step is either a
 * no-op version bump (interface widened, no data change) or a
 * targeted rewrite (v5 → v6 system:* rename, v6 → v7 activeSlug
 * removal).
 */

import type { PersistOptions } from 'zustand/middleware'
import type { DocsState, KnownDoc } from './types'

export const persistConfig: PersistOptions<
  DocsState,
  Pick<DocsState, 'openSlugs' | 'expandedDocSlugs'>
> = {
  name: 'writer-tauri:docs',
  version: 7,
  partialize: (s) => ({
    openSlugs: s.openSlugs,
    // activeSlug intentionally NOT persisted (v7) — URL is the
    // source of truth. See module docstring.
    // knownDocs no longer persisted (Path C): the source of truth
    // is the vault folder, hydrated on every boot via scanVault().
    // This eliminates the "two catalogs drift" class of bugs that
    // the title-mirror / backfill machinery existed to paper over.
    expandedDocSlugs: s.expandedDocSlugs,
  }),
  migrate: (persisted, version) => {
    // v1 → v2: KnownDoc gains optional archivedAt /
    // archivedFromParent. Pre-v2 entries are all live; absence of
    // these fields already encodes that, so this migration is a
    // no-op version bump that exists for traceability.
    // v2 → v3: KnownDoc.type union widens to include wiki:belief /
    // wiki:entity / wiki:episode. Existing 'daily' / 'writing'
    // entries remain valid — also a no-op bump, present for
    // traceability.
    // v3 → v4: KnownDoc.type wiki branch widens to template literal
    // `wiki:${string}` so the user can spawn custom wiki pages
    // alongside the seeds. No data migration needed.
    // v4 → v5: drop expandedWeekStarts. The week-grouped DocList
    // sidebar was replaced by the Day/Week/Month dropdown views, so
    // the week-fold state has no reader. Strip the key from any
    // persisted blob so the rehydrated state matches the new shape.
    // v5 → v6: split the agent-page bucket. The three system pages
    // (conventions / log / index) move from `wiki:*` to `system:*` so
    // prompt channels, sidebar grouping, and write-protection guards
    // can branch on a single prefix. User content pages
    // (`wiki:custom-...`) keep their type. Slug-keyed data is
    // unaffected — only the `knownDocs[i].type` string is rewritten.
    // v6 → v7: drop `activeSlug` from persisted state. The URL is
    // now the single source of truth for "which doc is open"; the
    // store field no longer exists, and persist would otherwise
    // resurrect a stale slug into the rehydrated shape forever.
    if (version < 7) {
      const { activeSlug: _drop, ...rest } =
        (persisted as { activeSlug?: unknown }) ?? {}
      persisted = rest
    }
    if (version < 6) {
      const state = (persisted ?? {}) as { knownDocs?: KnownDoc[] }
      const rename: Record<string, KnownDoc['type']> = {
        'wiki:conventions': 'system:conventions',
        'wiki:log': 'system:log',
        'wiki:index': 'system:index',
      }
      const nextKnownDocs = (state.knownDocs ?? []).map((doc) => {
        const renamed = rename[doc.type as string]
        return renamed ? { ...doc, type: renamed } : doc
      })
      persisted = { ...state, knownDocs: nextKnownDocs }
    }
    if (version < 5) {
      const { expandedWeekStarts: _drop, ...rest } =
        (persisted as { expandedWeekStarts?: unknown }) ?? {}
      return rest as DocsState
    }
    return persisted as DocsState
  },
}
