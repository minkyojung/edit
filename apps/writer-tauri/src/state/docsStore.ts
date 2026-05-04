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
import { todayLocalDate, writeDocMeta } from '@/hooks/useDocMeta'
import type { CollabHandle, CollabStatus } from '@/hooks/useCollabDoc'

const LEGACY_SLUG_KEY = 'writer-tauri:doc-slug'
const DEFAULT_DOC_TITLE = 'My Document'

/** Slim metadata mirrored into localStorage so the sidebar can list
 * docs (especially closed dailies whose ydoc isn't loaded). The
 * source of truth still lives in each doc's ydoc.getMap('meta');
 * this is a cache, refreshed whenever a doc is created or its meta
 * changes while open. */
export interface KnownDoc {
  slug: string
  type: 'daily' | 'writing'
  /** YYYY-MM-DD when type === 'daily'. */
  date?: string
  /** Parent doc's slug for tree-nested writing notes. Undefined for
   * roots (daily entries and any independent writing docs). */
  parentId?: string
}

interface DocsState {
  // Persisted
  openSlugs: string[]
  activeSlug: string | null
  knownDocs: KnownDoc[]

  // Runtime — never persisted
  handles: Record<string, CollabHandle>
  status: Record<string, CollabStatus>
  /** Set during bootstrap; turns to false when initial restore is done. */
  bootstrapping: boolean

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
  reorder: (slugs: string[]) => void
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

export const useDocsStore = create<DocsState>()(
  persist(
    (set, get) => ({
      openSlugs: [],
      activeSlug: null,
      knownDocs: [],
      handles: {},
      status: {},
      bootstrapping: true,

      bootstrap: async () => {
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
          }
        }

        // Add today to openSlugs if it isn't already there, and make
        // it the active tab. "Always land on today" is the design
        // promise of the daily journal.
        if (todaysDaily) {
          openSlugs = get().openSlugs
          if (!openSlugs.includes(todaysDaily.slug)) {
            openSlugs = [...openSlugs, todaysDaily.slug]
          }
          set({ openSlugs, activeSlug: todaysDaily.slug })
        }

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
            seedDailyTitleIfEmpty(handle.ydoc, known.date)
          }
        }

        // Legacy key cleanup once migration is durable.
        if (legacy && get().openSlugs.includes(legacy)) {
          localStorage.removeItem(LEGACY_SLUG_KEY)
        }

        set({ bootstrapping: false })
      },

      setActive: (slug) => {
        if (!get().openSlugs.includes(slug)) return
        set({ activeSlug: slug })
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
          const created = await proofClient.createDoc(DEFAULT_DOC_TITLE)
          const meta: KnownDoc = { slug: created.slug, type: 'writing' }
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
          seedDailyTitleIfEmpty(handle.ydoc, targetDate)
        }
        return slug
      },

      createChildNote: async (parentSlug) => {
        // Refuse to nest under something we don't know about — keeps
        // the tree from sprouting orphan branches if we get a stale
        // slug from the UI.
        if (!get().knownDocs.find((d) => d.slug === parentSlug)) return null
        try {
          // ZWS body — non-blank for the proof-server validator while
          // not seeding an H1 the user would have to clean up.
          const created = await proofClient.createDoc(DEFAULT_DOC_TITLE, '​')
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
          return null
        }
      },

      reorder: (slugs) => set({ openSlugs: slugs }),
    }),
    {
      name: 'writer-tauri:docs',
      version: 1,
      partialize: (s) => ({
        openSlugs: s.openSlugs,
        activeSlug: s.activeSlug,
        knownDocs: s.knownDocs,
      }),
    },
  ),
)

/** Seed a daily entry's title field with its anchor date so the user
 * sees the date in the title input the moment the doc opens. The
 * write only fires when the Y.Text is currently empty — once the
 * user customizes the title (e.g. adds a subtitle), we never
 * overwrite it. Wait for the provider to sync before checking, so we
 * don't race the server's existing-title content. */
function seedDailyTitleIfEmpty(ydoc: Y.Doc, date: string): void {
  const ytext = ydoc.getText('title')
  const seed = () => {
    if (ytext.toString().length > 0) return
    ydoc.transact(() => {
      ytext.insert(0, date)
    })
  }
  // The provider may not have replayed history yet on a freshly
  // created doc; defer one tick so any inbound title state is applied
  // before we decide it's empty.
  setTimeout(seed, 50)
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
  if (!handle) return
  set((s) => ({ handles: { ...s.handles, [slug]: handle } }))
}
