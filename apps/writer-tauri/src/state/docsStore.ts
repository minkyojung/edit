// Multi-document tab registry. Holds the set of open documents (slug
// list + active slug, persisted) and their live collab handles
// (ydoc + idb, runtime only — too live to serialize).
//
// Strategy: lazy-with-cache. Only the active doc gets a handle eagerly
// on bootstrap; switching to a tab that hasn't been opened yet
// triggers a one-shot setup (ydoc + idb persistence) and keeps it
// warm. Closing a tab tears its handle down to free the ydoc memory.
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
// IndexedDB is the single durable surface — there's no WebSocket sync.
import { IndexeddbPersistence } from 'y-indexeddb'
import { generateClientSlug } from '@/lib/slug'
import { formatLocalDate, todayLocalDate, writeDocMeta } from '@/hooks/useDocMeta'
import type { CollabHandle, CollabStatus } from '@/hooks/useCollabDoc'
import { notify } from '@/lib/notify'
import { deriveLabel } from '@/lib/docLabel'
import { useIngestStore } from './ingestStore'
import { useEditorViewStore } from './editorViewStore'
import { seedMarkdownIntoYDoc } from '@/lib/seedMarkdown'
import { applyVaultToHandle, installDocSync } from '@/lib/docFileSync'
import { useChatRuns } from '@/stores/chatRuns'

const LEGACY_SLUG_KEY = 'writer-tauri:doc-slug'

/** Slim metadata mirrored into localStorage so the sidebar can list
 * docs (especially closed dailies whose ydoc isn't loaded). The
 * source of truth still lives in each doc's ydoc.getMap('meta');
 * this is a cache, refreshed whenever a doc is created or its meta
 * changes while open. */
export interface KnownDoc {
  slug: string
  /** `system:*` = agent-owned meta surface (conventions / log / index)
   * that the LLM reads / maintains on dedicated prompt channels, not
   * through the wiki catalog. `wiki:*` = agent-managed content pages
   * (`wiki:custom-...`) the user accumulates over time. `daily` and
   * `writing` are user-authored. The two agent prefixes split a
   * pre-2026-05-13 single `wiki:*` bucket so sidebar grouping, prompt
   * channels, and write-protection guards line up with Karpathy's
   * schema-vs-wiki separation. */
  type: 'daily' | 'writing' | `system:${string}` | `wiki:${string}`
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

/** Coarse classification used by the DOC_POLICIES table below. Every
 * doc in the app falls into exactly one bucket, and each bucket
 * carries a fixed policy for archive, move, ingest, sidebar
 * placement, and write authority. Keeping the buckets coarse (4)
 * instead of mapping per `type` prefix avoids a wide table that
 * has to grow every time we add a new `system:about` or
 * `wiki:custom-...`. */
export type DocCategory =
  | 'daily'         // user-authored time-spine entry
  | 'writing'       // user-authored free note (may nest under daily / writing)
  | 'wiki-content'  // agent-created, user-editable wiki page (wiki:custom-*)
  | 'system-meta'   // agent-managed config / metadata (system:conventions/log/index)

/** Capability matrix for one doc category. Every caller that used
 * to ask "can this doc be archived / moved / ingested" reads from
 * this struct instead of hand-rolling a `type.startsWith(...)`
 * check. Add a new category → add one row → every gate updates. */
export interface DocPolicy {
  category: DocCategory
  /** Which sidebar region this doc belongs in. The Day / Week / Month
   * views render `date` and `none` (latter never appears); the
   * Wiki section splits `wiki` (content) and `system` (meta). */
  sidebarGroup: 'date' | 'wiki' | 'system' | 'none'
  /** User can soft-delete via archive UI. Karpathy write-ownership
   * invariant: only docs the user authored or owns can be wiped. */
  canArchive: boolean
  /** Eligible as moveDoc source or target parent (the wiki tree
   * surface). Daily entries are time-anchored, system pages are
   * fixed slots — neither participates in the tree's re-parenting. */
  canBeMovedInWikiTree: boolean
  /** Idle trigger considers this doc as an ingest source. Agent-
   * managed pages are output, not input, so they're false here
   * regardless of whether the user has typed into them. */
  isIngestSource: boolean
  /** LLM owns the canonical contents. User may read (and, for
   * conventions, edit), but the agent is the primary author.
   * Drives "no children under wiki", legacy mark migration scope,
   * markEdited observer skip, and similar guards. */
  isAgentManaged: boolean
}

const DAILY_POLICY: DocPolicy = {
  category: 'daily',
  sidebarGroup: 'date',
  canArchive: false,
  canBeMovedInWikiTree: false,
  isIngestSource: true,
  isAgentManaged: false,
}
const WRITING_POLICY: DocPolicy = {
  category: 'writing',
  sidebarGroup: 'date', // shown nested under its parent daily
  canArchive: true,
  canBeMovedInWikiTree: false,
  isIngestSource: true,
  isAgentManaged: false,
}
const WIKI_CONTENT_POLICY: DocPolicy = {
  category: 'wiki-content',
  sidebarGroup: 'wiki',
  canArchive: true,
  canBeMovedInWikiTree: true,
  isIngestSource: false,
  isAgentManaged: true,
}
const SYSTEM_META_POLICY: DocPolicy = {
  category: 'system-meta',
  sidebarGroup: 'system',
  canArchive: false,
  canBeMovedInWikiTree: false,
  isIngestSource: false,
  isAgentManaged: true,
}

/** Resolve a doc's policy by type. Unknown / legacy types fall
 * through to wiki-content — the v6 migration already moved the
 * pre-rename `wiki:conventions|log|index` to `system:*`, so any
 * leftover `wiki:*` here is genuinely user content (or corrupt
 * data we shouldn't crash on). */
export function getDocPolicy(doc: Pick<KnownDoc, 'type'>): DocPolicy {
  if (doc.type === 'daily') return DAILY_POLICY
  if (doc.type === 'writing') return WRITING_POLICY
  if (doc.type.startsWith('system:')) return SYSTEM_META_POLICY
  if (doc.type.startsWith('wiki:')) return WIKI_CONTENT_POLICY
  return WIKI_CONTENT_POLICY
}

/** True for any wiki-region page: agent-managed (`system:*` meta
 * and `wiki:custom-*` content). Now a thin wrapper over the
 * policy table so the source of truth is one struct, not two
 * helpers. Kept for callsite readability ("is this in the wiki
 * sidebar region?"). */
export function isWikiDoc(doc: Pick<KnownDoc, 'type'>): boolean {
  return getDocPolicy(doc).isAgentManaged
}

/** Karpathy write-ownership invariant: whoever wrote the page may
 * delete it. Thin wrapper around the policy table — `canArchive`
 * is true exactly for the category the user can wipe. */
export function isUserOwnedWiki(doc: Pick<KnownDoc, 'type'>): boolean {
  return getDocPolicy(doc).category === 'wiki-content'
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
  /** Move a user-owned wiki page (`wiki:custom-*`) under a new
   * parent — or to the root when `newParentId` is null. Returns
   * true on success, false when the move would violate one of:
   *
   *   - source isn't a user-owned wiki page
   *   - source is archived
   *   - new parent doesn't exist / is archived / isn't a live
   *     `wiki:custom-*` (system / daily / writing parents refused)
   *   - new parent is the source itself (self-parent)
   *   - new parent is a descendant of the source (would create
   *     a cycle)
   *
   * No-op (returns true) when the source already has this parent.
   * UI callers can ignore the boolean and just react to the
   * sidebar re-render; surfaces that want to surface a refusal
   * (drag-and-drop drop targets) can read the return value. */
  /** Seed a new doc's body from a markdown string. Used by
   * createCustomWikiPage / ensureSystemPage to plant initial content.
   * Ensures the handle (IDB shard + Y.Doc) exists first, then applies
   * a markdown → PM → Y.Doc update under the 'doc-init' origin so the
   * seed stays out of the undo stack.
   * No-op when the markdown is empty or when the editor parser
   * isn't mounted yet (caller should retry once a doc is active). */
  seedDocBody: (slug: string, markdown: string) => Promise<boolean>
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

// Synchronous local-only handle construction. The Y.Doc + IndexedDB
// layer come up immediately so the editor can mount and the user can
// type. Local writes never block on the network.
function buildHandle(
  slug: string,
  set: (fn: (s: DocsState) => Partial<DocsState>) => void,
  onStatus: (status: CollabStatus) => void,
): CollabHandle {
  const ydoc = new Y.Doc()
  const idb = new IndexeddbPersistence(slug, ydoc)
  const handle: CollabHandle = {
    ydoc,
    idb,
    idbSynced: idb.whenSynced.then(() => undefined),
    slug,
  }
  // Install the ingest dirty-bit tracker after IDB finishes hydrating
  // so the initial replay doesn't register as a fresh edit. From that
  // point on, any XmlFragment change (typing, mark accept, remote
  // sync) bumps ingestStore.lastEditedAt[slug] — that's the watermark
  // useIdleTrigger compares against lastIngestedAt to decide whether
  // the note is a candidate for re-ingest. Agent-managed pages
  // (`system:*` + `wiki:*`) are filtered out here via isWikiDoc so
  // ingest sources stay clean — those pages are output, not input.
  // No explicit unobserve: ydoc.destroy() in closeDoc tears down all
  // observers attached to fragments it owns.
  void idb.whenSynced.then(() => {
    const fragment = ydoc.getXmlFragment('prosemirror')
    fragment.observeDeep(() => {
      const known = useDocsStore.getState().knownDocs.find((d) => d.slug === slug)
      if (!known || isWikiDoc(known)) return
      useIngestStore.getState().markEdited(slug)
    })
  })

  // Vault file sync — observers that mark this slug dirty on any
  // Y.Doc mutation, plus a vault-to-memory load when IDB had nothing
  // for this slug. The auto-flush tick (Phase 4.B.1.b.iv.2+) reads
  // dirtySlugs and writes the .md + .marks.json pair. Disposer is
  // stashed on the handle so closeDoc can tear it down alongside
  // the ydoc.
  //
  // Vault load policy (Phase 4.B.1.c.iii):
  //   IDB takes priority — if it had data for this slug, we use that
  //   and skip the vault read. Only when the fragment is still empty
  //   after IDB sync (fresh launch with cleared IDB, or a slug that
  //   was first created on disk) do we hydrate from the vault. This
  //   is the conservative pivot: existing user data can't be lost,
  //   and Phase 4.E (file watcher) will introduce the symmetric
  //   "outside edit wins" path for vim/external changes.
  let vaultSyncDisposer: (() => void) | null = null
  void idb.whenSynced.then(async () => {
    const fragment = ydoc.getXmlFragment('prosemirror')
    // Use deriveLabel (text-walking) rather than fragment.length to
    // recognize "effectively empty". MilkdownEditor.tsx:281-290 fills
    // an empty fragment with a one-paragraph stub on mount; that mount
    // can race ahead of this .then callback, leaving fragment.length===1
    // even when no real text exists. seedDocBody handles the same
    // ambiguity the same way — keeping the rule consistent across both
    // seeding paths.
    if (deriveLabel(fragment).length === 0) {
      const outcome = await applyVaultToHandle(slug)
      if (outcome === 'applied') {
        console.log(`[vault:load] hydrated ${slug} from vault`)
      }
    }
    vaultSyncDisposer = installDocSync(slug, ydoc)
  })
  // Expose disposer via the handle's destroy chain by piggy-backing
  // on ydoc.destroy. closeDoc already calls ydoc.destroy(); add the
  // disposer call before destroying so observer cleanup runs while
  // the doc is still mountable.
  const originalDestroy = ydoc.destroy.bind(ydoc)
  ydoc.destroy = () => {
    vaultSyncDisposer?.()
    vaultSyncDisposer = null
    originalDestroy()
  }
  // IndexedDB is the single durable surface — status flips to 'ready'
  // once IDB hydrates the ydoc. 'error' covers the rare IDB failure
  // (Safari private mode / quota exhausted / browser bug) so the
  // footer can surface "storage unavailable" instead of leaving the
  // user silently writing into a session that won't persist.
  onStatus('loading')
  handle.idbSynced.then(
    () => onStatus('ready'),
    (err) => {
      console.error('[collab] IDB hydrate failed', err)
      onStatus('error')
    },
  )
  void set
  return handle
}

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
          // Client picks the slug locally so today's daily exists in the
          // catalog (and on disk via IndexedDB) before the server is
          // even reached. Registration is fire-and-forget — failures
          // just mean the doc stays local-only until the next online
          // boot, which is the right behavior for a daily journal that
          // must always greet the user with "today".
          //
          // Empty body — dailies derive their label from meta.date,
          // so the body must not seed a heading that would duplicate it.
          // Y.Doc + IDB shard come into being on first ensureHandle.
          const slug = generateClientSlug()
          const meta: KnownDoc = { slug, type: 'daily', date: today }
          todaysDaily = meta
          set((s) => ({ knownDocs: [...s.knownDocs, meta] }))
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
              const slug = generateClientSlug()
              const meta: KnownDoc = { slug, type: 'daily', date }
              set((s) => ({ knownDocs: [...s.knownDocs, meta] }))
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
        // Stop any chat run bound to this slug BEFORE destroying the
        // ydoc — a late proposal would otherwise try to apply against
        // a slug we've already torn down. (The pendingProposals queue
        // is gone with Track 1.2 reapply; proposals now route via
        // /ops directly, so no client-side queue to clear.)
        useChatRuns.getState().abortBySlug(slug)
        const handle = handles[slug]
        if (handle) {
          handle.idb.destroy()
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
          ensureHandle(finalActive, set, get).catch((err) =>
            console.error('[docs] post-close ensureHandle failed', err),
          )
        }
      },

      createNew: async () => {
        // Empty title + empty body. The displayed label falls back to
        // 'Untitled' in useDocLabel; the editor renders the body
        // placeholder hint. Nothing is seeded into the doc itself.
        const slug = generateClientSlug()
        const meta: KnownDoc = { slug, type: 'writing' }
        set((s) => ({
          openSlugs: [...s.openSlugs, slug],
          activeSlug: slug,
          knownDocs: [...s.knownDocs, meta],
        }))
        await ensureHandle(slug, set, get)
        const handle = get().handles[slug]
        if (handle) {
          writeDocMeta(handle.ydoc, {
            type: 'writing',
            createdAt: new Date().toISOString(),
          })
        }
      },

      openDaily: async (date) => {
        const targetDate = date ?? todayLocalDate()
        let known = get().knownDocs.find(
          (d) => d.type === 'daily' && d.date === targetDate,
        )
        if (!known) {
          // Empty body — dailies derive their label from meta.date, so
          // the body stays visually clean.
          const slug = generateClientSlug()
          known = { slug, type: 'daily', date: targetDate }
          set((s) => ({ knownDocs: [...s.knownDocs, known!] }))
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
        // Empty title + empty body. The displayed label falls back to
        // 'Untitled' in useDocLabel.
        const slug = generateClientSlug()
        const meta: KnownDoc = {
          slug,
          type: 'writing',
          parentId: parentSlug,
        }
        set((s) => ({
          knownDocs: [...s.knownDocs, meta],
          openSlugs: s.openSlugs.includes(slug)
            ? s.openSlugs
            : [...s.openSlugs, slug],
          activeSlug: slug,
        }))
        await ensureHandle(slug, set, get)
        const handle = get().handles[slug]
        if (handle) {
          writeDocMeta(handle.ydoc, {
            type: 'writing',
            parentId: parentSlug,
            createdAt: new Date().toISOString(),
          })
        }
        return slug
      },

      createWritingChild: async (parentSlug, title) => {
        const parent = get().knownDocs.find((d) => d.slug === parentSlug)
        if (!parent) return null
        if (isWikiDoc(parent)) return null
        // Empty body — server accepts it and the editor renders the
        // body placeholder. The title comes from the palette input.
        const slug = generateClientSlug()
        const meta: KnownDoc = {
          slug,
          type: 'writing',
          parentId: parentSlug,
          title,
        }
        set((s) => ({ knownDocs: [...s.knownDocs, meta] }))
        // Seed the body's first paragraph with the wikilink text via
        // ensureHandle's seedFirstLine option. Critical: the seed runs
        // *inside* ensureHandle, before the handle is published to the
        // store, so MilkdownEditor never sees an empty fragment and
        // its schema-fill branch can't race with this seed. The
        // 'doc-init' transaction origin keeps the seed out of the undo
        // stack so Cmd+Z right after opening doesn't strip the name.
        await ensureHandle(slug, set, get, { seedFirstLine: title })
        const handle = get().handles[slug]
        if (handle) {
          writeDocMeta(handle.ydoc, {
            type: 'writing',
            parentId: parentSlug,
            createdAt: new Date().toISOString(),
          })
        }
        return slug
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
        // Agent-managed wiki/system pages are protected from accidental
        // wipe (Karpathy write-ownership invariant). User-spawned
        // wiki:custom-* pages are the user's own writing surface, so
        // they follow the regular ownership rule and can be archived.
        if (isWikiDoc(target) && !isUserOwnedWiki(target)) return false
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
        // Cancel chat runs for the whole cascade before tearing
        // handles down. Same reasoning as closeDoc: late proposals
        // must not race past a destroyed ydoc. (Pending-proposal
        // queues are gone with Track 1.2 reapply; /ops handles
        // application server-side now.)
        const chatRuns = useChatRuns.getState()
        for (const s of groupSlugs) {
          chatRuns.abortBySlug(s)
        }
        const nextHandles = { ...state.handles }
        const nextStatus = { ...state.status }
        for (const s of groupSlugs) {
          const h = nextHandles[s]
          if (h) {
            h.idb.destroy()
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

        // The empty-strip invariant uses the *post-archive* catalog
        // (so today's daily must still be archive-free in nextKnown).
        // Pass a synthesized state to ensureNonEmptyTabStrip rather
        // than the live one so the lookup sees nextKnown.
        const postState: DocsState = { ...state, knownDocs: nextKnown }
        set(ensureNonEmptyTabStrip(postState, {
          knownDocs: nextKnown,
          openSlugs: nextOpen,
          activeSlug: nextActive,
          handles: nextHandles,
          status: nextStatus,
        }))
        // Warm whichever slug ended up active — whether nextActive
        // survived or the invariant fell back to today's daily.
        const finalActive = get().activeSlug
        if (finalActive && !get().handles[finalActive]) {
          ensureHandle(finalActive, set, get).catch((err) =>
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
        // Agent-managed wiki/system pages can't reach this code path
        // today (archive is refused above) but assert it anyway so a
        // future regression can't silently wipe agent memory. User-
        // spawned wiki:custom-* pages reach archive, so they're
        // allowed through here and follow normal hard-delete.
        if (isWikiDoc(target) && !isUserOwnedWiki(target)) return
        const stamp = target.archivedAt
        const groupSlugs = state.knownDocs
          .filter((d) => d.archivedAt === stamp)
          .map((d) => d.slug)
        // Wipe each slug's IDB shard. Without this, a future tab
        // re-using the same slug would resurrect the cached Y.Doc
        // updates.
        let failed = 0
        for (const s of groupSlugs) {
          indexedDB.deleteDatabase(s)
        }
        const groupSet = new Set(groupSlugs)
        const cur = get()
        const nextKnown = cur.knownDocs.filter((d) => !groupSet.has(d.slug))
        const nextOpen = cur.openSlugs.filter((sl) => !groupSet.has(sl))
        const nextExpanded = cur.expandedDocSlugs.filter((sl) => !groupSet.has(sl))
        const postState: DocsState = { ...cur, knownDocs: nextKnown }
        set(ensureNonEmptyTabStrip(postState, {
          knownDocs: nextKnown,
          openSlugs: nextOpen,
          expandedDocSlugs: nextExpanded,
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

      seedDocBody: async (slug, markdown) => {
        if (!markdown.trim()) return false
        await ensureHandle(slug, set, get)
        const handle = get().handles[slug]
        if (!handle) return false
        // Wait for IndexedDB hydration to complete before reading
        // or writing the fragment. Without this we race: the read
        // path (deriveLabel below) sees an empty fragment, the
        // seed lands a fresh update, and the IDB hydrate that
        // arrives microseconds later merges in the pre-existing
        // schema-fill paragraph alongside it. Outcome depends on
        // which doc is active, which is why "case A failed, case
        // B succeeded" was non-deterministic.
        await handle.idbSynced
        const parser = useEditorViewStore.getState().parser
        if (!parser) {
          // Caller is responsible for retrying once a parser is
          // available (e.g. after mounting any doc). We log instead
          // of throw so the calling ingest pipeline doesn't crash.
          console.warn('[docs] seedDocBody: parser not ready, skipping', slug)
          return false
        }
        // Don't double-seed. The check looks at user-visible text,
        // not raw XML. fragment.toString() returns wrappers like
        // `<paragraph></paragraph>` for the schema's empty-doc
        // fill (planted by MilkdownEditor.tsx:280-292 the first
        // time the doc is mounted), so a naive trim().length > 0
        // would skip every doc that's been opened once. deriveLabel
        // walks Y.XmlText.toDelta inserts only — a non-empty result
        // means real text exists.
        const labelText = deriveLabel(handle.ydoc.getXmlFragment('prosemirror'))
        if (labelText.length > 0) return false
        return seedMarkdownIntoYDoc(handle.ydoc, markdown, parser)
      },

      emptyArchive: async () => {
        const archived = get().knownDocs.filter((d) => d.archivedAt)
        if (archived.length === 0) return
        let failed = 0
        for (const d of archived) {
          indexedDB.deleteDatabase(d.slug)
        }
        const archivedSet = new Set(archived.map((d) => d.slug))
        const cur = get()
        const nextKnown = cur.knownDocs.filter((d) => !archivedSet.has(d.slug))
        const nextOpen = cur.openSlugs.filter((sl) => !archivedSet.has(sl))
        const nextExpanded = cur.expandedDocSlugs.filter((sl) => !archivedSet.has(sl))
        const postState: DocsState = { ...cur, knownDocs: nextKnown }
        set(ensureNonEmptyTabStrip(postState, {
          knownDocs: nextKnown,
          openSlugs: nextOpen,
          expandedDocSlugs: nextExpanded,
        }))
        if (get().openSlugs.length === 0) {
          void get().openDaily().catch((err) =>
            console.error('[docs] post-emptyArchive openDaily failed', err),
          )
        }
        if (failed > 0) {
          notify.cantEmptyTrash({ onRetry: () => get().emptyArchive() })
        }
      },
    }),
    {
      name: 'writer-tauri:docs',
      version: 6,
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
/** Seed `<paragraph>text</paragraph>` (or `<paragraph/>` when `text`
 * is empty) into a brand-new doc's body fragment. Used by the create
 * paths via ensureHandle's `seedFirstLine` option so that:
 *   1. MilkdownEditor's schema-fill branch never sees an empty
 *      fragment and therefore can't race with the seed (the fragment
 *      is already populated by the time the handle is published).
 *   2. The label system (deriveLabel reads the first non-empty
 *      block) picks up the wikilink text uniformly when one is
 *      supplied.
 * No-op when the fragment is already non-empty — defensive against
 * a caller passing this option on a reopen path. */
function seedBodyFirstLine(ydoc: Y.Doc, text: string): void {
  const fragment = ydoc.getXmlFragment('prosemirror')
  if (fragment.length > 0) return
  ydoc.transact(() => {
    const paragraph = new Y.XmlElement('paragraph')
    if (text.length > 0) {
      paragraph.insert(0, [new Y.XmlText(text)])
    }
    fragment.insert(0, [paragraph])
  }, 'doc-init')
}

/** Apply the "tab strip is never empty" invariant to a state patch
 * about to be passed to set(). If the patch (or current state, if
 * the patch doesn't touch openSlugs) would leave openSlugs empty,
 * today's daily slug is folded back in synchronously and made active
 * — so the user never sees a blank tab strip, regardless of whether
 * any follow-up async work succeeds or fails.
 *
 * The store-level invariant lives here rather than scattered across
 * each mutation (closeDoc / archiveDoc / deleteForever / emptyArchive)
 * because the policy is identical at every site: "if removing this
 * slug would empty the strip, fall back to today's daily." Putting it
 * in one helper means the rule has one definition and one place to
 * change.
 *
 * No-op when today's daily isn't in the catalog (bootstrap hasn't
 * run yet, or the day rolled over since bootstrap). In that edge
 * case the strip stays empty for the moment — caller's own async
 * follow-up (ensureHandle, openDaily) is the next line of defense,
 * but it's not relied on for the common path. */
function ensureNonEmptyTabStrip(
  state: DocsState,
  patch: Partial<DocsState>,
): Partial<DocsState> {
  const nextOpen = patch.openSlugs ?? state.openSlugs
  if (nextOpen.length > 0) return patch
  const today = todayLocalDate()
  const todayDaily = state.knownDocs.find(
    (d) => d.type === 'daily' && d.date === today && !d.archivedAt,
  )
  if (!todayDaily) return patch
  return {
    ...patch,
    openSlugs: [todayDaily.slug],
    activeSlug: todayDaily.slug,
  }
}

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
 * the same slug returns immediately.
 *
 * `opts.seedFirstLine`: when supplied (only by brand-new-doc create
 * paths), the body fragment is seeded with `<paragraph>text</paragraph>`
 * (or a single empty paragraph if `text` is '') *before* the handle is
 * published to the store. That ordering is the race fix: by the time
 * MilkdownEditor receives the handle, the fragment is already
 * non-empty, so its schema-fill branch never fires and can't compete
 * with the seed. Callers must NOT pass this option for handles that
 * are merely reopening an existing doc — the seed would land on top
 * of whatever IndexedDB is about to hydrate. */
async function ensureHandle(
  slug: string,
  set: (
    fn:
      | Partial<DocsState>
      | ((s: DocsState) => Partial<DocsState>),
  ) => void,
  get: () => DocsState,
  opts?: { seedFirstLine?: string },
): Promise<void> {
  if (get().handles[slug]) return
  // Local-only handle is ready immediately (Y.Doc + IndexedDB are sync).
  // No server sync layer since Phase 3.C — every doc operation runs
  // against the local Y.Doc + IDB.
  const handle = buildHandle(
    slug,
    set as (fn: (s: DocsState) => Partial<DocsState>) => void,
    (status) => {
      set((s) => ({ status: { ...s.status, [slug]: status } }))
    },
  )
  if (opts?.seedFirstLine !== undefined) {
    seedBodyFirstLine(handle.ydoc, opts.seedFirstLine)
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

/** Mirror the doc's derived label back into knownDocs.title so closed
 * docs still show their real label in the sidebar / palette / etc.
 * The label comes from the body's first non-empty block (see
 * lib/docLabel.ts), not specifically the first h1.
 *
 * Gated by provider sync to avoid the pre-bootstrap window where the
 * local state is incomplete. Once sync completes, the ydoc state is
 * authoritative and every change — including transitions to empty —
 * is mirrored straight through. Display callers fall back to
 * 'Untitled' in one place (hooks/useDocLabel.ts).
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
  if (!known) return
  // Title-mirror runs for any user-editable doc: writing notes
  // AND user-owned wiki:custom-* pages. Both follow the same rule
  // now: the body's first non-empty block is the title, and the
  // sidebar / palette read it from knownDocs.title which this
  // mirror keeps in sync.
  //
  // Excluded:
  //   - daily       → label comes from meta.date, body is free
  //   - system:*    → agent-managed meta pages; their title is
  //                   fixed by the type id
  //
  // The previous regression where wiki pages got renamed by their
  // first bullet (e.g. "Michael" → "Joined as new manager") is
  // prevented at the *content* layer: ingest now writes
  // `# {entity}` as the body's first line (see useIdleTrigger
  // materializeNewPageProposals). The mirror still extracts the
  // first block's plain text — but that text IS the entity name
  // when the heading is in place.
  const eligible =
    known.type === 'writing' ||
    (known.type.startsWith('wiki:custom-'))
  if (!eligible) return

  const fragment = handle.ydoc.getXmlFragment('prosemirror')
  const sync = () => {
    set((s) => {
      const idx = s.knownDocs.findIndex((d) => d.slug === slug)
      if (idx < 0) return s
      const cur = s.knownDocs[idx]
      // Same eligibility guard as the outer setup. A future code
      // path that calls sync() from elsewhere shouldn't clobber
      // titles on daily / system docs.
      const stillEligible =
        cur.type === 'writing' ||
        cur.type.startsWith('wiki:custom-')
      if (!stillEligible) return s

      // Wiki pages: only mirror when the body's first block is a
      // heading. Legacy ingest-created pages have bullet-first
      // bodies — mirroring them would copy the first bullet
      // ("새 매니저로 합류") into the catalog title and rename
      // the page (the "Michael → Joined as new manager" regression).
      // The new ingest layer writes `# {entity}` as the first line,
      // so future pages pass this guard automatically. Existing
      // pages keep their cached title until the user types a
      // heading at the top — at which point mirror takes over.
      if (cur.type.startsWith('wiki:custom-')) {
        const children = fragment.toArray()
        const first = children[0]
        const isHeading =
          first instanceof Y.XmlElement && first.nodeName === 'heading'
        if (!isHeading) return s
      }

      const next = deriveLabel(fragment)
      if ((cur.title ?? '') === next) return s
      const list = [...s.knownDocs]
      list[idx] = { ...cur, title: next }
      return { knownDocs: list }
    })
  }
  const start = () => {
    sync()
    // observeDeep so edits inside block text children update the
    // cache, not just structural changes at the fragment root.
    fragment.observeDeep(sync)
  }
  if (handle.idb.synced) {
    start()
    return
  }
  // IDB is the single durable surface since Phase 3.C — its 'synced'
  // event fires once the local store has hydrated the ydoc.
  let started = false
  const onceReady = () => {
    if (started) return
    started = true
    handle.idb.off('synced', onceReady)
    start()
  }
  handle.idb.on('synced', onceReady)
}
