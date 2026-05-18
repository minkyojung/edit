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
import * as Y from 'yjs'
import { generateClientSlug } from '@/lib/slug'
import { formatLocalDate, todayLocalDate, writeDocMeta } from '@/hooks/useDocMeta'
import type { CollabHandle, CollabStatus } from '@/hooks/useCollabDoc'
import { notify } from '@/lib/notify'
import { deriveLabel } from '@/lib/docLabel'
import { useIngestStore } from '../ingestStore'
import { useEditorViewStore } from '../editorViewStore'
import { seedMarkdownIntoYDoc } from '@/lib/seedMarkdown'
import {
  applyVaultBodyToYDoc,
  flushDirty,
  installDocSync,
  markSlugDirty,
} from '@/lib/docFileSync'
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
import type { DocsState, KnownDoc, DocPolicy } from './types'

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

// DocsState lives in ./types — every action signature documented there.

// Synchronous local-only handle construction. The Y.Doc comes up
// immediately so the editor can mount; content arrives async via the
// vault load chained on contentReady. There is no IndexedDB layer in
// Path C — the vault file is the only durable surface and the ydoc
// lives only in memory for the session.
function buildHandle(
  slug: string,
  set: (fn: (s: DocsState) => Partial<DocsState>) => void,
  onStatus: (status: CollabStatus) => void,
): CollabHandle {
  const ydoc = new Y.Doc()

  // contentReady: doc-hydration signal that consumers await before
  // touching content-dependent state (editor binding, mark store
  // reads, dirty observers, chat threads). Spans:
  //   1. Vault load        (.md + sidecar → Y.Doc)
  //   2. installDocSync    (start watching for dirty-mark observers)
  //   3. ingest observer   (mark this slug "edited" on any change)
  //
  // Folding (2) and (3) into the same chain means dirty tracking only
  // begins AFTER the initial hydrate, so the seed doesn't register as
  // a fresh edit.
  let vaultSyncDisposer: (() => void) | null = null
  const contentReady = (async () => {
    const fragment = ydoc.getXmlFragment('prosemirror')
    // Use deriveLabel (text-walking) rather than fragment.length —
    // MilkdownEditor's mount fills an empty fragment with a
    // paragraph stub that can race ahead, leaving length===1 even
    // when no real text exists.
    if (deriveLabel(fragment).length === 0) {
      // Body only — marks need an EditorView which hasn't mounted yet
      // (this IIFE runs BEFORE MilkdownEditor mounts). The view-side
      // step lives in MilkdownEditor's mount: restoreMarksFromSidecar
      // fires after onViewReady so the marks land on the same doc
      // they were anchored against during the previous session.
      const outcome = await applyVaultBodyToYDoc(ydoc, slug).catch((err) => {
        console.warn('[vault:load] failed for', slug, err)
        return 'no-vault' as const
      })
      if (outcome === 'applied') {
        console.log(`[vault:load] hydrated ${slug} body from vault`)
      }
    }
    vaultSyncDisposer = installDocSync(slug, ydoc)

    // Ingest dirty-bit observer. Installed AFTER hydrate so the
    // initial seed doesn't register as a fresh edit. Agent-managed
    // pages (system:* + wiki:*) are filtered out — those pages are
    // output, not input. No explicit unobserve: ydoc.destroy() in
    // closeDoc tears down all observers attached to its fragments.
    fragment.observeDeep(() => {
      const known = useDocsStore.getState().knownDocs.find((d) => d.slug === slug)
      if (!known || isWikiDoc(known)) return
      useIngestStore.getState().markEdited(slug)
    })
  })()
  const handle: CollabHandle = {
    ydoc,
    contentReady,
    slug,
  }
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
  // Status flips to 'ready' once the doc's body + marks are fully
  // hydrated into the ydoc (IDB cache today, vault load layered on top
  // in Path C). 'error' covers the rare hydrate failure so the footer
  // can surface "storage unavailable" instead of leaving the user
  // silently writing into a session that won't persist.
  onStatus('loading')
  handle.contentReady.then(
    () => onStatus('ready'),
    (err) => {
      console.error('[collab] content hydrate failed', err)
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
        // Writings only nest 1-deep under a daily. Wiki pages are
        // roots. Anything else (including another writing) is refused
        // — the Karpathy wiki pattern relies on flat-on-disk +
        // [[link]] connections rather than folder depth. Callers
        // holding a non-daily slug (e.g. ⌘N pressed while a writing
        // is active) must resolve to the writing's daily ancestor
        // first via findDailyAncestorSlug.
        if (parent.type !== 'daily') return null
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
        // Same 1-deep-under-daily rule as createChildNote. The wikilink
        // palette callsite resolves to the active doc's daily ancestor
        // before calling this, so a non-daily parent here is a coding
        // bug rather than user-reachable state.
        if (parent.type !== 'daily') return null
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

      findDailyAncestorSlug: (slug) => {
        const docs = get().knownDocs
        const visited = new Set<string>()
        let current = docs.find((d) => d.slug === slug)
        while (current && !visited.has(current.slug)) {
          visited.add(current.slug)
          if (current.type === 'daily') return current.slug
          if (!current.parentId) return null
          current = docs.find((d) => d.slug === current!.parentId)
        }
        return null
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
        // Path C: no IDB shards to clean. Vault file deletion is the
        // only durable cleanup needed, but that's not wired yet — the
        // user removes files from Finder if they want the disk freed.
        // Legacy IDB shards (pre-Path-C) get cleared by a one-time
        // wipe path during migration; not handled here.
        const failed = 0
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

      renameDoc: (slug, newTitle) => {
        const trimmed = newTitle.trim()
        if (trimmed.length === 0) return false
        const idx = get().knownDocs.findIndex((d) => d.slug === slug)
        if (idx < 0) return false
        const cur = get().knownDocs[idx]
        // Only user-editable doc types can be renamed. Daily titles
        // are derived from date; system page titles are derived from
        // the type suffix.
        const eligible =
          cur.type === 'writing' || cur.type.startsWith('wiki:custom-')
        if (!eligible) return false
        if (cur.title === trimmed) return true
        const list = [...get().knownDocs]
        list[idx] = { ...cur, title: trimmed }
        set({ knownDocs: list })
        // Mark dirty + fire an immediate flush so the rename lands on
        // disk right away. The 2s timer-based flush would also catch
        // it eventually, but for an explicit user action like Rename
        // the UI expectation is that Finder reflects the change now,
        // not 2s later. flushDirty walks dirtySlugs and applies the
        // rename-on-change machinery (Phase 4.B.1.c.vi).
        markSlugDirty(slug)
        void flushDirty()
        return true
      },

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
        await handle.contentReady
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
        // Path C: no IDB shards to clean. Vault files stay on disk —
        // user removes them from Finder if they want the space back.
        const failed = 0
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
  // Path C Step 4: title-mirror removed (Obsidian model). Body and
  // filename are decoupled — typing in the body never changes the
  // doc's title. Title changes go through the explicit renameDoc
  // action (Command Palette → "Rename current note") which updates
  // knownDocs.title; the existing rename-on-change machinery (Phase
  // 4.B.1.c.vi) then moves the file on disk.
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

// installTitleMirror — removed in Path C Step 4.
//
// Previously this observer kept knownDocs[*].title in sync with the
// body's first line. Path C decoupled body and title (Obsidian model):
// the body is free-form content, the title / filename is changed only
// by the explicit renameDoc action below. That eliminates the class
// of bugs where AI / user edits to the body silently renamed the file
// on disk, and removes the wiki-only heading-guard branch that
// existed to mitigate the worst case of the same regression.
