// Multi-document tab registry. Holds the set of open documents (slug
// list + active slug, persisted) and their live collab handles
// (ydoc + provider, runtime only — too live to serialize).
//
// Strategy: lazy-with-cache. Only the active doc gets a handle eagerly
// on bootstrap; switching to a tab that hasn't been opened yet
// triggers a one-shot setup (collab session + provider + ydoc) and
// keeps it warm. Closing a tab tears its handle down to release the
// WebSocket and free the ydoc memory.
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
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { proofClient, waitUntilReady } from '@/lib/proofClient'
import { formatLocalDate, todayLocalDate, writeDocMeta } from '@/hooks/useDocMeta'
import type { CollabHandle, CollabStatus } from '@/hooks/useCollabDoc'
import { notify } from '@/lib/notify'
import { readH1TitleFromFragment } from '@/lib/docTitle'

const LEGACY_SLUG_KEY = 'writer-tauri:doc-slug'
// Server-side title sentinel for newly-created writing docs. The
// client never displays this directly — knownDocs.title is left
// undefined so useDocLabel's fallback shows 'Untitled', and the
// editor body's h1 starts empty so the placeholder plugin shows
// 'Untitled' there too. proof-server requires a non-empty title at
// create time, so we send this sentinel to satisfy it.
const UNTITLED_SENTINEL = 'Untitled'

/** Slim metadata mirrored into localStorage so the sidebar can list
 * docs (especially closed dailies whose ydoc isn't loaded). The
 * source of truth still lives in each doc's ydoc.getMap('meta');
 * this is a cache, refreshed whenever a doc is created or its meta
 * changes while open. */
export interface KnownDoc {
  slug: string
  type: 'daily' | 'writing' | `wiki:${string}`
  /** YYYY-MM-DD when type === 'daily'. */
  date?: string
  /** Parent doc's slug for tree-nested writing notes. Undefined for
   * roots (daily entries and any independent writing docs). */
  parentId?: string
  /** Cached mirror of the doc's Y.Text('title') for writing-type
   * entries. Lets the sidebar / palette / breadcrumb show the right
   * label even when the doc's collab handle hasn't been opened yet
   * (lazy-load strategy). Source of truth is still the Y.Text;
   * this is a snapshot kept in sync via a per-handle observer (set
   * up in ensureHandle) and bumped immediately at create time so
   * brand-new docs aren't briefly "Untitled". Daily entries don't
   * use this — their label derives from `date`. */
  title?: string
  /** Archive timestamp (ms since epoch). Set when the user archives
   * the doc; cleared when restored. Archived docs stay in knownDocs
   * so they can be restored, but are filtered out of sidebar tree,
   * wikilink palette, and search. A cascade-archive writes the same
   * timestamp to a parent and all its descendants so the group can
   * be restored together. Mirrors the threads-archive pattern from
   * useThreads — same word, same shape. */
  archivedAt?: number
  /** Snapshot of `parentId` taken at archive time so restore can put
   * the doc back where it was. While archived, `parentId` is left
   * undefined so the doc doesn't pollute the live tree index. */
  archivedFromParent?: string
}

/** Karpathy-style write-ownership split: `wiki:*` docs are LLM-
 * synthesized memory pages (belief / entity / episode). They live
 * in the same catalog as user notes but are protected from archive
 * and hard-delete so the user can't accidentally wipe the agent's
 * memory. Single field, single predicate — every guard branches
 * off this one helper. */
export function isWikiDoc(doc: Pick<KnownDoc, 'type'>): boolean {
  return doc.type.startsWith('wiki:')
}

interface DocsState {
  // Persisted
  openSlugs: string[]
  activeSlug: string | null
  knownDocs: KnownDoc[]
  /** Slugs of docs whose tree row is currently expanded in the
   * sidebar — daily and writing alike. Persisted so the user's
   * fold layout survives a reload. Today's daily is force-added
   * during bootstrap so the writing surface always greets them
   * with their day's notes already in view. */
  expandedDocSlugs: string[]

  // Runtime — never persisted
  handles: Record<string, CollabHandle>
  status: Record<string, CollabStatus>
  /** Set during bootstrap; turns to false when initial restore is done. */
  bootstrapping: boolean
  /** Which sidebar date view is showing. Runtime-only — every session
   * starts on 'day' so the app reads as "you're here, now" on launch. */
  sidebarTab: 'day' | 'week' | 'month'
  /** Month the Month view is currently showing (YYYY-MM). Runtime-only —
   * the natural anchor on each launch is the current month. */
  monthAnchor: string
  /** Date the Day view is currently showing (YYYY-MM-DD). Runtime-only —
   * resets to today on each launch so the app reads as "you're here, now"
   * regardless of where the user wandered last session. */
  dayAnchor: string

  // Actions
  bootstrap: () => Promise<void>
  setActive: (slug: string) => void
  closeDoc: (slug: string) => void
  createNew: () => Promise<void>
  /** Find or create the daily entry for the given local date and make
   * it the active tab. Returns the slug. */
  openDaily: (date?: string) => Promise<string | null>
  /** Create a new writing-type note nested under `parentSlug`,
   * register it in knownDocs with parentId set, open its tab, and
   * activate. Returns the new slug. */
  createChildNote: (parentSlug: string) => Promise<string | null>
  /** Create a writing child without activating its tab. Used by the
   * wikilink palette so creating a link doesn't yank the user out of
   * the parent doc mid-sentence. Seeds the child's Y.Text title with
   * the provided label so sidebar listings stop showing "Untitled"
   * for nodes the user explicitly named. Returns the new slug. */
  createWritingChild: (parentSlug: string, title: string) => Promise<string | null>
  /** Toggle the sidebar fold for a given doc. */
  toggleExpanded: (slug: string) => void
  reorder: (slugs: string[]) => void
  /** Archive `slug` and all its descendants (cascade). Closes any
   * open tabs in the group, tears down their handles, and reassigns
   * activeSlug if needed. The group is tagged with a single
   * timestamp so restore can move them back together. Refuses to
   * act on daily entries. Returns true on success. */
  archiveDoc: (slug: string) => boolean
  /** Restore an archived group identified by `slug` (any group
   * member works). Re-points each parentId to its pre-archive
   * value via `archivedFromParent`. */
  unarchiveDoc: (slug: string) => void
  /** Permanently delete an archived group: hits the sidecar DELETE
   * for each member, removes them from knownDocs / openSlugs /
   * handles. No-op if the slug isn't archived. */
  deleteForever: (slug: string) => Promise<void>
  /** Permanently delete every archived doc (sidecar + local state). */
  emptyArchive: () => Promise<void>
  /** Switch the sidebar date view. */
  setSidebarTab: (tab: 'day' | 'week' | 'month') => void
  /** Set the Month view's anchor month (YYYY-MM). */
  setMonthAnchor: (anchor: string) => void
  /** Step the Month view's anchor by `delta` months (-1 / +1). */
  shiftMonth: (delta: number) => void
  /** Set the Day view's anchor date (YYYY-MM-DD). */
  setDayAnchor: (anchor: string) => void
  /** Step the Day view's anchor by `delta` days (-1 / +1). */
  shiftDay: (delta: number) => void
}

async function buildHandle(
  slug: string,
  onStatus: (status: CollabStatus) => void,
): Promise<CollabHandle | null> {
  const ready = await waitUntilReady(15_000)
  if (!ready) {
    onStatus('error')
    return null
  }
  let session: Awaited<ReturnType<typeof proofClient.getCollabSession>>['session']
  try {
    const res = await proofClient.getCollabSession(slug)
    session = res.session
  } catch (err) {
    console.error('[docs] failed to get collab session', err)
    onStatus('error')
    return null
  }
  const url = new URL(session.collabWsUrl)
  url.searchParams.set('token', session.token)
  url.searchParams.set('role', session.role)

  const ydoc = new Y.Doc()
  const provider = new HocuspocusProvider({
    url: url.toString(),
    name: slug,
    document: ydoc,
    token: session.token,
    onStatus: ({ status }) => {
      onStatus(status === 'connected' ? 'connected' : 'connecting')
    },
  })
  onStatus('connecting')
  return { ydoc, provider, slug }
}

// Re-entrancy guard for bootstrap().
//
// React Strict Mode intentionally double-invokes effects in dev, so
// BootGate's `useEffect(() => bootstrap(), [])` fires twice in quick
// succession. The first call awaits proofClient.createDoc(today, ...)
// for a ~100ms round-trip; in that window the second call sees the
// catalog still empty and ALSO calls createDoc. Two server-side docs
// for the same date, two sidebar tabs, every boot. Catalog audit
// confirmed this pattern: 12 of 14 days carried exactly 2 dailies.
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
      expandedDocSlugs: [],
      handles: {},
      status: {},
      bootstrapping: true,
      sidebarTab: 'day',
      monthAnchor: monthAnchorOf(todayLocalDate()),
      dayAnchor: todayLocalDate(),

      bootstrap: async () => {
        // Skip if another bootstrap is mid-flight (see the comment on
        // `bootstrapInFlight` above this store definition for the full
        // race rationale).
        if (bootstrapInFlight) return
        bootstrapInFlight = true
        try {
        const today = todayLocalDate()

        // First, migrate the legacy single-slug localStorage entry. We
        // adopt it as today's daily so the user's existing content is
        // preserved at the obvious anchor (today). Tomorrow they'll
        // get a fresh blank daily and yesterday's content stays
        // accessible at its anchor.
        const legacy = localStorage.getItem(LEGACY_SLUG_KEY)
        let { openSlugs, activeSlug, knownDocs } = get()
        if (legacy && knownDocs.length === 0) {
          knownDocs = [{ slug: legacy, type: 'daily', date: today }]
          if (openSlugs.length === 0) {
            openSlugs = [legacy]
            activeSlug = legacy
          }
          set({ openSlugs, activeSlug, knownDocs })
        }

        // Make sure today's daily exists. If knownDocs has one for
        // today, use it; otherwise create a fresh one.
        let todaysDaily = knownDocs.find(
          (d) => d.type === 'daily' && d.date === today,
        )
        if (!todaysDaily) {
          try {
            // Zero-width space markdown — proof-server rejects blank
            // bodies (markdown.trim() check), but we don't want a body
            // H1 duplicating the date that the title field already
            // shows. ZWS passes the trim guard while rendering as an
            // empty paragraph in the editor.
            const created = await proofClient.createDoc(today, '​')
            const meta: KnownDoc = { slug: created.slug, type: 'daily', date: today }
            todaysDaily = meta
            set((s) => ({ knownDocs: [...s.knownDocs, meta] }))
          } catch (err) {
            console.error('[docs] failed to create today daily', err)
            notify.cantOpenJournal()
          }
        }

        // Add today to openSlugs if it isn't already there, and make
        // it the active tab. "Always land on today" is the design
        // promise of the daily journal. Also force-add today's slug
        // to expandedDocSlugs so the sidebar greets the user with
        // the day's notes already visible (yesterday becomes its own
        // slug tomorrow, so this auto-rolls).
        if (todaysDaily) {
          openSlugs = get().openSlugs
          if (!openSlugs.includes(todaysDaily.slug)) {
            openSlugs = [...openSlugs, todaysDaily.slug]
          }
          set({ openSlugs, activeSlug: todaysDaily.slug })
          set((s) => ({
            expandedDocSlugs: s.expandedDocSlugs.includes(todaysDaily!.slug)
              ? s.expandedDocSlugs
              : [...s.expandedDocSlugs, todaysDaily!.slug],
          }))
        }

        // Backfill: ensure every day in the current calendar week
        // has a real daily entry, so the Week view (sliding 7 days
        // from today) and the Month view both render with their
        // markers populated rather than blooming in slowly. Fire-and-
        // forget so the editor opens at full speed; the sidebar
        // reacts as each create lands.
        const currentWeekStart = weekStartFor(today)
        void (async () => {
          const cursor = new Date(currentWeekStart)
          const weekEnd = new Date(currentWeekStart)
          weekEnd.setDate(weekEnd.getDate() + 6)
          while (cursor <= weekEnd) {
            const yyyy = cursor.getFullYear()
            const mm = String(cursor.getMonth() + 1).padStart(2, '0')
            const dd = String(cursor.getDate()).padStart(2, '0')
            const date = `${yyyy}-${mm}-${dd}`
            const exists = get().knownDocs.some(
              (k) => k.type === 'daily' && k.date === date,
            )
            if (!exists) {
              try {
                const created = await proofClient.createDoc(date, '​')
                const meta: KnownDoc = { slug: created.slug, type: 'daily', date }
                set((s) => ({ knownDocs: [...s.knownDocs, meta] }))
              } catch (err) {
                console.error('[docs] backfill daily failed', date, err)
              }
            }
            cursor.setDate(cursor.getDate() + 1)
          }
        })()

        // Defensive: ensure activeSlug points at something real.
        const finalState = get()
        if (
          !finalState.activeSlug ||
          !finalState.openSlugs.includes(finalState.activeSlug)
        ) {
          set({ activeSlug: finalState.openSlugs[0] ?? null })
        }

        // Eagerly connect the active slug. Once connected, write meta
        // back to its ydoc if it's a daily that doesn't yet have meta
        // (covers the legacy migration path). Other tabs stay lazy.
        const slugToOpen = get().activeSlug
        if (slugToOpen) {
          await ensureHandle(slugToOpen, set, get)
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

        // Legacy key cleanup once migration is durable.
        if (legacy && get().openSlugs.includes(legacy)) {
          localStorage.removeItem(LEGACY_SLUG_KEY)
        }

        // Ensure the user's wiki pages (belief / entity / episode)
        // exist. Fire-and-forget so first paint isn't blocked on
        // these round-trips. The chat runner reads wiki content
        // lazily before each turn, so even if a create lands a
        // moment after bootstrap, the next chat picks it up.
        void import('./wikiService').then(({ ensureWikiDocs }) =>
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
          ensureHandle(slug, set, get).catch((err) =>
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
        const handle = handles[slug]
        if (handle) {
          handle.provider.destroy()
          handle.ydoc.destroy()
        }
        const nextHandles = { ...handles }
        delete nextHandles[slug]
        const nextStatus = { ...get().status }
        delete nextStatus[slug]
        set({
          openSlugs: next,
          activeSlug: nextActive,
          handles: nextHandles,
          status: nextStatus,
        })
        // If we closed the active and a neighbor exists, make sure it's
        // also got a handle so the editor doesn't show a blank state.
        if (nextActive && !nextHandles[nextActive]) {
          ensureHandle(nextActive, set, get).catch((err) =>
            console.error('[docs] post-close ensureHandle failed', err),
          )
        }
      },

      createNew: async () => {
        try {
          const created = await proofClient.createDoc(UNTITLED_SENTINEL, '​')
          const meta: KnownDoc = {
            slug: created.slug,
            type: 'writing',
          }
          set((s) => ({
            openSlugs: [...s.openSlugs, created.slug],
            activeSlug: created.slug,
            knownDocs: [...s.knownDocs, meta],
          }))
          await ensureHandle(created.slug, set, get)
          const handle = get().handles[created.slug]
          if (handle) {
            writeDocMeta(handle.ydoc, {
              type: 'writing',
              createdAt: new Date().toISOString(),
            })
          }
        } catch (err) {
          console.error('[docs] createNew failed', err)
          notify.cantCreateNote({ onRetry: () => get().createNew() })
        }
      },

      openDaily: async (date) => {
        const targetDate = date ?? todayLocalDate()
        let known = get().knownDocs.find(
          (d) => d.type === 'daily' && d.date === targetDate,
        )
        if (!known) {
          try {
            // ZWS body — see the bootstrap comment above for the
            // proof-server blank-markdown guard. Title field carries
            // the date, body stays visually clean.
            const created = await proofClient.createDoc(targetDate, '​')
            known = { slug: created.slug, type: 'daily', date: targetDate }
            set((s) => ({ knownDocs: [...s.knownDocs, known!] }))
          } catch (err) {
            console.error('[docs] openDaily createDoc failed', err)
            notify.cantOpenJournal({ onRetry: () => get().openDaily(targetDate) })
            return null
          }
        }
        const slug = known.slug
        if (!get().openSlugs.includes(slug)) {
          set((s) => ({ openSlugs: [...s.openSlugs, slug] }))
        }
        set({ activeSlug: slug })
        await ensureHandle(slug, set, get)
        const handle = get().handles[slug]
        if (handle) {
          if (!handle.ydoc.getMap('meta').get('type')) {
            writeDocMeta(handle.ydoc, {
              type: 'daily',
              date: targetDate,
              createdAt: new Date().toISOString(),
            })
          }
          scrubDailyTitleArtifacts(handle.ydoc)
        }
        return slug
      },

      createChildNote: async (parentSlug) => {
        // Refuse to nest under something we don't know about — keeps
        // the tree from sprouting orphan branches if we get a stale
        // slug from the UI.
        const parent = get().knownDocs.find((d) => d.slug === parentSlug)
        if (!parent) return null
        // Wiki pages are roots; user notes don't hang off them.
        if (isWikiDoc(parent)) return null
        try {
          // ZWS body — non-blank for the proof-server validator while
          // not seeding an H1 the user would have to clean up. The
          // h1 will be added (empty) by the editor's first render and
          // the placeholder plugin paints 'Untitled' on top of it.
          const created = await proofClient.createDoc(UNTITLED_SENTINEL, '​')
          const meta: KnownDoc = {
            slug: created.slug,
            type: 'writing',
            parentId: parentSlug,
          }
          set((s) => ({
            knownDocs: [...s.knownDocs, meta],
            openSlugs: s.openSlugs.includes(created.slug)
              ? s.openSlugs
              : [...s.openSlugs, created.slug],
            activeSlug: created.slug,
          }))
          await ensureHandle(created.slug, set, get)
          const handle = get().handles[created.slug]
          if (handle) {
            writeDocMeta(handle.ydoc, {
              type: 'writing',
              parentId: parentSlug,
              createdAt: new Date().toISOString(),
            })
          }
          return created.slug
        } catch (err) {
          console.error('[docs] createChildNote failed', err)
          notify.cantCreateNote({ onRetry: () => get().createChildNote(parentSlug) })
          return null
        }
      },

      createWritingChild: async (parentSlug, title) => {
        const parent = get().knownDocs.find((d) => d.slug === parentSlug)
        if (!parent) return null
        if (isWikiDoc(parent)) return null
        try {
          // ZWS body for the same reason daily / writing creates use
          // it: proof-server rejects blank markdown but we don't want
          // a default H1 in the body.
          const created = await proofClient.createDoc(title, '​')
          const meta: KnownDoc = {
            slug: created.slug,
            type: 'writing',
            parentId: parentSlug,
            title,
          }
          set((s) => ({ knownDocs: [...s.knownDocs, meta] }))
          await ensureHandle(created.slug, set, get)
          const handle = get().handles[created.slug]
          if (handle) {
            writeDocMeta(handle.ydoc, {
              type: 'writing',
              parentId: parentSlug,
              createdAt: new Date().toISOString(),
            })
            const ytext = handle.ydoc.getText('title')
            if (ytext.toString().length === 0) {
              // 'doc-init' origin — seeding the title of a freshly-
              // created wikilink child is a system action, not
              // something the user should be able to Cmd+Z (they'd
              // end up with an empty-titled doc that the catalog
              // still references).
              handle.ydoc.transact(() => {
                ytext.insert(0, title)
              }, 'doc-init')
            }
          }
          return created.slug
        } catch (err) {
          console.error('[docs] createWritingChild failed', err)
          notify.cantCreateNote({
            onRetry: () => get().createWritingChild(parentSlug, title),
          })
          return null
        }
      },

      toggleExpanded: (slug) =>
        set((s) => ({
          expandedDocSlugs: s.expandedDocSlugs.includes(slug)
            ? s.expandedDocSlugs.filter((x) => x !== slug)
            : [...s.expandedDocSlugs, slug],
        })),

      reorder: (slugs) => set({ openSlugs: slugs }),

      archiveDoc: (slug) => {
        const state = get()
        const target = state.knownDocs.find((d) => d.slug === slug)
        if (!target) return false
        // Daily entries are time-axis spine, not user-authored docs.
        // Refuse so the sidebar/breadcrumb invariants stay intact.
        if (target.type === 'daily') return false
        // Wiki docs are agent memory — protected from accidental
        // wipe (Karpathy write-ownership invariant).
        if (isWikiDoc(target)) return false
        if (target.archivedAt) return false

        const groupSlugs = collectDescendantSlugs(state.knownDocs, slug)
        const stamp = Date.now()
        const groupSet = new Set(groupSlugs)

        // Close any open tabs in the group, destroy their handles, and
        // pick a sensible new activeSlug if the active was inside.
        const nextOpen = state.openSlugs.filter((s) => !groupSet.has(s))
        let nextActive = state.activeSlug
        if (state.activeSlug && groupSet.has(state.activeSlug)) {
          const idx = state.openSlugs.indexOf(state.activeSlug)
          // First non-group slug at or after idx; else most recent before.
          nextActive =
            state.openSlugs.slice(idx + 1).find((s) => !groupSet.has(s)) ??
            [...state.openSlugs.slice(0, idx)].reverse().find((s) => !groupSet.has(s)) ??
            null
        }
        const nextHandles = { ...state.handles }
        const nextStatus = { ...state.status }
        for (const s of groupSlugs) {
          const h = nextHandles[s]
          if (h) {
            h.provider.destroy()
            h.ydoc.destroy()
          }
          delete nextHandles[s]
          delete nextStatus[s]
        }

        const nextKnown = state.knownDocs.map((d) =>
          groupSet.has(d.slug)
            ? {
                ...d,
                archivedAt: stamp,
                archivedFromParent: d.parentId,
                parentId: undefined,
              }
            : d,
        )

        set({
          knownDocs: nextKnown,
          openSlugs: nextOpen,
          activeSlug: nextActive,
          handles: nextHandles,
          status: nextStatus,
        })

        // If we shifted activeSlug to a known but unloaded tab, warm it
        // up so the editor doesn't sit on a stale handle.
        if (nextActive && !nextHandles[nextActive]) {
          ensureHandle(nextActive, set, get).catch((err) =>
            console.error('[docs] post-archive ensureHandle failed', err),
          )
        }
        return true
      },

      unarchiveDoc: (slug) => {
        const state = get()
        const target = state.knownDocs.find((d) => d.slug === slug)
        if (!target?.archivedAt) return
        const stamp = target.archivedAt
        // Restore everything archived in the same batch (same
        // timestamp) so a cascade is undone as a unit.
        const nextKnown = state.knownDocs.map((d) =>
          d.archivedAt === stamp
            ? {
                ...d,
                parentId: d.archivedFromParent,
                archivedAt: undefined,
                archivedFromParent: undefined,
              }
            : d,
        )
        set({ knownDocs: nextKnown })
      },

      deleteForever: async (slug) => {
        const state = get()
        const target = state.knownDocs.find((d) => d.slug === slug)
        if (!target?.archivedAt) return
        // Wiki docs can't reach this code path today (archive is
        // refused above) but assert it anyway so a future regression
        // can't silently wipe agent memory.
        if (isWikiDoc(target)) return
        const stamp = target.archivedAt
        const groupSlugs = state.knownDocs
          .filter((d) => d.archivedAt === stamp)
          .map((d) => d.slug)
        // Best-effort sidecar deletion. If a slug fails (already gone,
        // 404, network blip), keep going so the user isn't stuck with
        // orphaned trash entries.
        let failed = 0
        for (const s of groupSlugs) {
          try {
            await proofClient.deleteDocForever(s)
          } catch (err) {
            console.error('[docs] deleteDocForever failed', s, err)
            failed += 1
          }
        }
        const groupSet = new Set(groupSlugs)
        set((s) => ({
          knownDocs: s.knownDocs.filter((d) => !groupSet.has(d.slug)),
          openSlugs: s.openSlugs.filter((sl) => !groupSet.has(sl)),
          expandedDocSlugs: s.expandedDocSlugs.filter((sl) => !groupSet.has(sl)),
        }))
        if (failed > 0) {
          notify.cantDeleteNote({ onRetry: () => get().deleteForever(slug) })
        }
      },

      setSidebarTab: (tab) => set({ sidebarTab: tab }),

      setMonthAnchor: (anchor) => set({ monthAnchor: anchor }),

      shiftMonth: (delta) =>
        set((s) => ({ monthAnchor: shiftMonthAnchor(s.monthAnchor, delta) })),

      setDayAnchor: (anchor) => set({ dayAnchor: anchor }),

      shiftDay: (delta) =>
        set((s) => ({ dayAnchor: shiftDayAnchor(s.dayAnchor, delta) })),

      emptyArchive: async () => {
        const archived = get().knownDocs.filter((d) => d.archivedAt)
        if (archived.length === 0) return
        let failed = 0
        for (const d of archived) {
          try {
            await proofClient.deleteDocForever(d.slug)
          } catch (err) {
            console.error('[docs] emptyArchive item failed', d.slug, err)
            failed += 1
          }
        }
        const archivedSet = new Set(archived.map((d) => d.slug))
        set((s) => ({
          knownDocs: s.knownDocs.filter((d) => !archivedSet.has(d.slug)),
          openSlugs: s.openSlugs.filter((sl) => !archivedSet.has(sl)),
          expandedDocSlugs: s.expandedDocSlugs.filter((sl) => !archivedSet.has(sl)),
        }))
        if (failed > 0) {
          notify.cantEmptyTrash({ onRetry: () => get().emptyArchive() })
        }
      },
    }),
    {
      name: 'writer-tauri:docs',
      version: 5,
      partialize: (s) => ({
        openSlugs: s.openSlugs,
        activeSlug: s.activeSlug,
        knownDocs: s.knownDocs,
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

/** Extract the YYYY-MM anchor from a YYYY-MM-DD date string. */
export function monthAnchorOf(date: string): string {
  return date.slice(0, 7)
}

/** Step a YYYY-MM-DD date by `delta` days (negative for past). Mirrors
 * shiftMonthAnchor — UTC-free local-time arithmetic so day boundaries
 * follow the user's wall clock. */
export function shiftDayAnchor(date: string, delta: number): string {
  const d = new Date(date)
  d.setDate(d.getDate() + delta)
  return formatLocalDate(d)
}

/** Step a YYYY-MM anchor by `delta` months (negative for past). */
export function shiftMonthAnchor(anchor: string, delta: number): string {
  const [yStr, mStr] = anchor.split('-')
  const y = Number(yStr)
  const m = Number(mStr) // 1-12
  // JS Date math: month is 0-indexed and auto-rolls year boundaries.
  const d = new Date(y, m - 1 + delta, 1)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${yyyy}-${mm}`
}

/** Compute the Monday-anchored start of the calendar week
 * containing `date` (YYYY-MM-DD). ISO-week convention. */
export function weekStartFor(date: string): string {
  const d = new Date(date)
  const day = d.getDay() // 0=Sun … 6=Sat
  // Distance back to Monday: Sun→6, Mon→0, Tue→1, … Sat→5.
  const back = day === 0 ? 6 : day - 1
  d.setDate(d.getDate() - back)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/** BFS over knownDocs to collect `root` plus every descendant via
 * parentId. Used by archiveDoc to assemble the cascade group in one
 * pass. Skips already-archived entries so a re-archive of a subtree
 * doesn't double-batch. */
function collectDescendantSlugs(docs: KnownDoc[], root: string): string[] {
  const out: string[] = [root]
  const queue: string[] = [root]
  while (queue.length) {
    const parent = queue.shift()!
    for (const d of docs) {
      if (d.parentId === parent && !d.archivedAt && !out.includes(d.slug)) {
        out.push(d.slug)
        queue.push(d.slug)
      }
    }
  }
  return out
}

/** Daily entries derive their displayed title from meta.date — they
 * have no editable title of their own. Earlier versions seeded the
 * date into Y.Text('title'), which raced with collab sync and
 * sometimes produced duplicated values like "2026-05-042026-05-04".
 * This scrubber clears any leftover Y.Text('title') content for a
 * daily; the label everywhere (tabs, sidebar, breadcrumb, header)
 * now reads from meta.date instead, so clearing the Y.Text is safe
 * and removes the legacy artifact in one shot. */
function scrubDailyTitleArtifacts(ydoc: Y.Doc): void {
  const ytext = ydoc.getText('title')
  if (ytext.length === 0) return
  // 'doc-init' origin — system cleanup of legacy artefacts; not a
  // user action and not undo-able by design.
  ydoc.transact(() => {
    ytext.delete(0, ytext.length)
  }, 'doc-init')
}

/** Internal: lazy-create a handle for `slug`, register it, and route
 * status updates back into the store. Idempotent — a second call for
 * the same slug returns immediately. */
async function ensureHandle(
  slug: string,
  set: (
    fn:
      | Partial<DocsState>
      | ((s: DocsState) => Partial<DocsState>),
  ) => void,
  get: () => DocsState,
): Promise<void> {
  if (get().handles[slug]) return
  set((s) => ({ status: { ...s.status, [slug]: 'initializing' } }))
  const handle = await buildHandle(slug, (status) => {
    set((s) => ({ status: { ...s.status, [slug]: status } }))
  })
  if (!handle) {
    // proof-server unreachable or session denied. Toast once so the user
    // knows their tab is dead instead of silently sitting on the editor's
    // 'error' status banner. Retry re-runs the same setup.
    notify.cantOpenNote({ onRetry: () => ensureHandle(slug, set, get) })
    return
  }
  set((s) => ({ handles: { ...s.handles, [slug]: handle } }))
  seedMetaFromCatalog(handle, get().knownDocs.find((d) => d.slug === slug))
  installTitleMirror(slug, handle, set, get)
}

/** Mirror catalog-level type/date into the doc's Y.Map('meta') the
 * first time we open the handle, so meta becomes the single source of
 * truth that everything else (normalize, footer, hover popovers) can
 * read without racing the bootstrap.
 *
 * No-op when meta.type already exists — that's the steady state after
 * the first seed (or for docs that were created by an already-meta-
 * aware build). Skips silently when catalog has no entry, since there
 * is nothing authoritative to copy.
 *
 * createdAt is deliberately NOT seeded here — back-stamping a fresh
 * timestamp on a doc that was created last week would lie about its
 * age. Create paths set createdAt themselves at the real creation
 * moment; legacy docs simply have an empty createdAt forever, which
 * is correct. */
function seedMetaFromCatalog(handle: CollabHandle, known: KnownDoc | undefined): void {
  if (!known) return
  const metaMap = handle.ydoc.getMap('meta')
  if (metaMap.get('type')) return
  writeDocMeta(handle.ydoc, {
    type: known.type,
    date: known.type === 'daily' ? known.date : undefined,
  })
}

/** Mirror title changes back into knownDocs.title so closed docs still
 * show their real label in the sidebar / palette / etc. Reads the
 * title from the body's first level-1 heading — the single source of
 * truth post Stage-2 title fold.
 *
 * Gated by provider sync — before the first sync, the local state is
 * incomplete and reading "" would clobber the persisted cache (which
 * often holds the title set at create time). After sync, the ydoc
 * state is authoritative and we mirror every change.
 *
 * Daily entries are skipped: their label comes from `meta.date`, not
 * the body. Cleanup happens implicitly when handle.ydoc.destroy() in
 * closeDoc tears down all observers. */
function installTitleMirror(
  slug: string,
  handle: CollabHandle,
  set: (
    fn:
      | Partial<DocsState>
      | ((s: DocsState) => Partial<DocsState>),
  ) => void,
  get: () => DocsState,
): void {
  const known = get().knownDocs.find((d) => d.slug === slug)
  if (known?.type === 'daily') return

  const fragment = handle.ydoc.getXmlFragment('prosemirror')
  const sync = () => {
    const next = readH1TitleFromFragment(fragment)
    // Never overwrite the cached title with an empty value. Two
    // different scenarios produce next === '' and we can't tell
    // them apart from this side:
    //   (a) Legitimate: the user emptied the title h1
    //   (b) Pre-bootstrap: the migration hasn't run yet (e.g. the
    //       observer fired before provider.synced got far enough)
    // Treating both as "clear the cache" loses (b)'s real label.
    // Preserve the last known good value instead; (a) accepts a
    // tiny staleness on close, while (b) keeps its label.
    if (next.length === 0) return
    set((s) => {
      const idx = s.knownDocs.findIndex((d) => d.slug === slug)
      if (idx < 0) return s
      const cur = s.knownDocs[idx]
      if (cur.type === 'daily') return s
      if (cur.title === next) return s
      const list = [...s.knownDocs]
      list[idx] = { ...cur, title: next }
      return { knownDocs: list }
    })
  }
  const start = () => {
    sync()
    // observeDeep so edits inside the h1's text children update the
    // cache, not just structural changes at the fragment root.
    fragment.observeDeep(sync)
  }
  if (handle.provider.isSynced) {
    start()
    return
  }
  let started = false
  const onceSynced = () => {
    if (started) return
    started = true
    handle.provider.off('synced', onceSynced)
    start()
  }
  handle.provider.on('synced', onceSynced)
}
