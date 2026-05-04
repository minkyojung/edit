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
import type { CollabHandle, CollabStatus } from '@/hooks/useCollabDoc'

const LEGACY_SLUG_KEY = 'writer-tauri:doc-slug'
const DEFAULT_DOC_TITLE = 'My Document'

interface DocsState {
  // Persisted
  openSlugs: string[]
  activeSlug: string | null

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
      handles: {},
      status: {},
      bootstrapping: true,

      bootstrap: async () => {
        // Migrate the old single-slug localStorage entry on first run.
        // Keep the legacy key in place after reading so users can roll
        // back if something blows up; we only delete it once the new
        // store has at least one slug persisted.
        const legacy = localStorage.getItem(LEGACY_SLUG_KEY)
        let { openSlugs, activeSlug } = get()
        if (openSlugs.length === 0 && legacy) {
          openSlugs = [legacy]
          activeSlug = legacy
          set({ openSlugs, activeSlug })
        }

        // No docs at all → create one so the editor isn't empty on first
        // launch. Same default title the legacy code used.
        if (openSlugs.length === 0) {
          try {
            const created = await proofClient.createDoc(DEFAULT_DOC_TITLE)
            set({ openSlugs: [created.slug], activeSlug: created.slug })
            openSlugs = [created.slug]
            activeSlug = created.slug
          } catch (err) {
            console.error('[docs] bootstrap createDoc failed', err)
            set({ bootstrapping: false })
            return
          }
        }

        // Make sure the active slug actually exists in the open list
        // (defensive — persisted state could disagree if the user closed
        // the active tab before we shipped).
        if (!activeSlug || !openSlugs.includes(activeSlug)) {
          activeSlug = openSlugs[0] ?? null
          set({ activeSlug })
        }

        // Eagerly connect the active slug only. Others wait for a switch.
        if (activeSlug) {
          await ensureHandle(activeSlug, set, get)
        }

        // Legacy key cleanup once we've migrated successfully.
        if (legacy && openSlugs.includes(legacy)) {
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
          set((s) => ({
            openSlugs: [...s.openSlugs, created.slug],
            activeSlug: created.slug,
          }))
          await ensureHandle(created.slug, set, get)
        } catch (err) {
          console.error('[docs] createNew failed', err)
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
      }),
    },
  ),
)

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
