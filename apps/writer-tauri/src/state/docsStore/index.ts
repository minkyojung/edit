// Multi-document tab registry. Holds the set of open documents (slug
// list + active slug, persisted) and their live collab handles
// (ydoc, runtime only — too live to serialize).
//
// Strategy: lazy-with-cache. Only the active doc gets a handle eagerly
// on bootstrap; switching to a tab that hasn't been opened yet
// triggers a one-shot setup (fresh ydoc + vault load) and keeps it
// warm. Closing a tab tears its handle down to free the ydoc memory.
//
// Path C: the vault folder is the single durable source. There is no
// IndexedDB layer — each handle's Y.Doc is built fresh on first open
// and hydrated from the .md + sidecar pair on disk. The catalog
// (knownDocs) is derived from a vault scan at bootstrap, not
// persisted to localStorage. See scanVault.ts.
//
// Eager-everything is the Cursor-style ideal but costs N parallel
// WebSocket connections on app start; for a writer with 5–9 docs
// that's overkill. The cache means subsequent switches are instant
// after the first hit.
//
// Migration: the old single-doc 'writer-tauri:doc-slug' key gets
// folded into openSlugs the first time the new store boots so users
// don't lose their existing document.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { generateClientSlug } from '@/lib/slug'
import { todayLocalDate, writeDocMeta } from '@/hooks/useDocMeta'
import { scanVault } from '@/lib/scanVault'
import { useChatRuns } from '@/stores/chatRuns'

// Type definitions live in ./types so future slice files in this
// directory share one canonical shape without circular sibling
// imports. Re-export here so external consumers (43 files) keep
// using `import { type KnownDoc, ... } from '@/state/docsStore'`
// unchanged.
export type {
  KnownDoc,
  DocCategory,
  DocPolicy,
} from './types'
import type { DocsState, KnownDoc } from './types'

// Pure helpers (doc policy table + date arithmetic) live in ./helpers.
// Re-exported so external consumers keep `import { isWikiDoc, ... }
// from '@/state/docsStore'` unchanged.
export {
  getDocPolicy,
  isWikiDoc,
  isUserOwnedWiki,
  monthAnchorOf,
  shiftDayAnchor,
  shiftMonthAnchor,
  weekStartFor,
} from './helpers'
import { ensureNonEmptyTabStrip } from './helpers'
import { createDateNavSlice } from './dateNavSlice'
import { createSidebarSlice } from './sidebarSlice'
import { createEditSlice } from './editSlice'
import { createHandlesSlice, scrubDailyTitleArtifacts } from './handlesSlice'
import { createCreateSlice } from './createSlice'
import { createArchiveSlice } from './archiveSlice'

// DocsState lives in ./types — every action signature documented there.

// Re-entrancy guard for bootstrap().
//
// React Strict Mode intentionally double-invokes effects in dev, so
// BootGate's `useEffect(() => bootstrap(), [])` fires twice in quick
// succession. Without a guard, the second call sees the catalog
// half-built and races to create a duplicate daily — historically
// 12 of 14 days carried exactly 2 dailies. This module-level flag
// short-circuits the second call.
//
// Module-level flag (not in store state) so it lives across the
// store's set() updates — store-state guard would race with the same
// async window we are trying to protect. try/finally so a thrown
// bootstrap (network failure during legacy migration etc.) doesn't
// leave the guard latched and block legitimate later reboots within
// the same process.
let bootstrapInFlight = false

export const useDocsStore = create<DocsState>()(
  persist(
    (set, get) => ({
      openSlugs: [],
      activeSlug: null,
      knownDocs: [],
      bootstrapping: true,

      ...createSidebarSlice(set),
      ...createDateNavSlice(set),
      ...createEditSlice(set, get),
      ...createHandlesSlice(set, get),
      ...createCreateSlice(set, get),
      ...createArchiveSlice(set, get),

      bootstrap: async () => {
        // Skip if another bootstrap is mid-flight (see the comment on
        // `bootstrapInFlight` above this store definition for the full
        // race rationale).
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
          let activeSlug: string | null = openSlugs.includes(
            get().activeSlug ?? '',
          )
            ? get().activeSlug
            : null

          // Today's daily is always promoted into the tab strip
          // ("always land on today" is the journal's design promise).
          if (!openSlugs.includes(todaysDaily.slug)) {
            openSlugs = [...openSlugs, todaysDaily.slug]
          }
          if (!activeSlug) activeSlug = todaysDaily.slug
          set({ openSlugs, activeSlug })
          set((s) => ({
            expandedDocSlugs: s.expandedDocSlugs.includes(todaysDaily!.slug)
              ? s.expandedDocSlugs
              : [...s.expandedDocSlugs, todaysDaily!.slug],
          }))

          // Defensive: ensure activeSlug still points somewhere real
          // after the validation pass above. Edge case — openSlugs
          // ended up empty after filtering AND today's daily insert
          // somehow didn't land. Picks any tab to avoid a null-active
          // session that breaks the editor mount.
          const finalState = get()
          if (
            !finalState.activeSlug ||
            !finalState.openSlugs.includes(finalState.activeSlug)
          ) {
            set({ activeSlug: finalState.openSlugs[0] ?? null })
          }

          // Eagerly connect the active slug so first paint shows
          // content. Daily docs get their meta seeded if missing
          // (covers the path where today's daily is brand new and
          // has no meta map yet).
          const slugToOpen = get().activeSlug
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
          // Kept so a future "ensure conventions / log / index" pass
          // has a wired entry point.
          void import('../wikiService').then(({ ensureWikiDocs }) =>
            ensureWikiDocs(),
          ).catch((err) =>
            console.error('[wiki] bootstrap wiki failed', err),
          )

          set({ bootstrapping: false })
        } finally {
          bootstrapInFlight = false
        }
      },

      setActive: (slug) => {
        // Bring any known doc to the foreground. If it isn't yet a
        // tab (e.g. wiki entries that live in the catalog without
        // ever having been opened), promote it to one. Unknown
        // slugs no-op so a stale UI handle can't corrupt activeSlug.
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
        // ydoc — a late proposal would otherwise try to apply against
        // a slug we've already torn down. (The pendingProposals queue
        // is gone with Track 1.2 reapply; proposals now route via
        // /ops directly, so no client-side queue to clear.)
        useChatRuns.getState().abortBySlug(slug)
        const handle = handles[slug]
        if (handle) {
          handle.ydoc.destroy()
        }
        const nextHandles = { ...handles }
        delete nextHandles[slug]
        const nextStatus = { ...get().status }
        delete nextStatus[slug]
        // Single set: the empty-strip invariant is folded into the
        // same patch via ensureNonEmptyTabStrip, so the UI never
        // flickers through a blank state and there's no async
        // follow-up that can fail and leave the user stuck.
        set(ensureNonEmptyTabStrip(get(), {
          openSlugs: next,
          activeSlug: nextActive,
          handles: nextHandles,
          status: nextStatus,
        }))
        // Warm the new active slug's handle if it isn't loaded yet —
        // applies whether the invariant kicked in (today's daily) or
        // we just shifted to a neighbor.
        const finalActive = get().activeSlug
        if (finalActive && !get().handles[finalActive]) {
          get().ensureHandle(finalActive).catch((err) =>
            console.error('[docs] post-close ensureHandle failed', err),
          )
        }
      },

      reorder: (slugs) => set({ openSlugs: slugs }),

    }),
    {
      name: 'writer-tauri:docs',
      version: 6,
      partialize: (s) => ({
        openSlugs: s.openSlugs,
        activeSlug: s.activeSlug,
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
        // v2 → v3: KnownDoc.type union widens to include
        // wiki:belief / wiki:entity / wiki:episode. Existing
        // 'daily' / 'writing' entries remain valid — also a no-op
        // bump, present for traceability.
        // v3 → v4: KnownDoc.type wiki branch widens to template
        // literal `wiki:${string}` so the user can spawn custom
        // wiki pages alongside the seeds. No data migration needed.
        // v4 → v5: drop expandedWeekStarts. The week-grouped DocList
        // sidebar was replaced by the Day/Week/Month dropdown views,
        // so the week-fold state has no reader. Strip the key from
        // any persisted blob so the rehydrated state matches the new
        // shape (silently ignored fields are fine; explicit removal
        // is cleaner).
        // v5 → v6: split the agent-page bucket. The three system
        // pages (conventions / log / index) move from `wiki:*` to
        // `system:*` so prompt channels, sidebar grouping, and
        // write-protection guards can branch on a single prefix.
        // User content pages (`wiki:custom-...`) keep their type.
        // Slug-keyed data (ydoc bodies in IndexedDB, ingestStore's
        // edit / ingest watermarks, queued proposals, marks Y.Maps)
        // is unaffected — only the `knownDocs[i].type` string is
        // rewritten. Unknown legacy prefixes pass through unchanged.
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
    },
  ),
)

// installTitleMirror — removed in Path C Step 4.
//
// Previously this observer kept knownDocs[*].title in sync with the
// body's first line. Path C decoupled body and title (Obsidian model):
// the body is free-form content, the title / filename is changed only
// by the explicit renameDoc action below. That eliminates the class
// of bugs where AI / user edits to the body silently renamed the file
// on disk, and removes the wiki-only heading-guard branch that
// existed to mitigate the worst case of the same regression.
