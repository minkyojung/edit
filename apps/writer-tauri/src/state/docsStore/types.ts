/**
 * docsStore — shared types.
 *
 * The store's surface is split across many slice files in this
 * directory; centralising the type declarations here lets every slice
 * import a single canonical shape without circular imports between
 * sibling slice files. Consumers of the store import these types
 * indirectly via `@/state/docsStore` (the index.ts re-exports them).
 *
 * Persistence map (kept in sync with persistConfig.ts):
 *   Persisted    — openSlugs, expandedDocSlugs
 *   Runtime-only — handles, status, bootstrapping,
 *                  sidebarTab, monthAnchor, dayAnchor, knownDocs
 *
 * NOTE: "which doc is the user looking at" is NOT in the store. The
 * URL is the source of truth — see useActiveSlug. The store carries
 * only the tab strip (openSlugs) and per-doc metadata.
 *
 * NOTE: `knownDocs` is intentionally NOT persisted — the on-disk vault
 * is the single source of truth. See bootstrap() which calls
 * `scanVault()` at every launch.
 */

import type { CollabHandle, CollabStatus } from '@/hooks/useCollabDoc'

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
  /** ISO timestamp recorded when the doc was first created. Phase 5b
   * of the Yjs-removal migration lifted this off `Y.Map('meta')` and
   * onto the catalog / `.meta.json` sidecar — see DocMetaFile in
   * `apps/writer-tauri/src/lib/docPaths.ts`. Absent on legacy docs
   * whose Y.Map had no createdAt either; DocumentInfoDialog renders
   * `—` in that case. */
  createdAt?: string
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
  | 'wiki-profile'  // user self-profile — editable + ingest-updatable, non-archivable
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

/** Top-level store shape. Slices each implement a sub-shape of this
 * interface; the combined creator in `index.ts` spreads them into a
 * single zustand store. */
export interface DocsState {
  // Persisted
  openSlugs: string[]
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
  /** Lazy-create the in-memory handle for `slug` if it doesn't
   * already exist, register it on `handles`, and route status
   * updates back into `status`. Idempotent — a second call for
   * the same slug returns immediately.
   *
   * `opts.seedFirstLine`: when supplied (only by brand-new-doc
   * create paths), the body fragment is seeded with one paragraph
   * containing `text` (or an empty paragraph if `text` is '')
   * BEFORE the handle is published to the store. That ordering
   * is the race fix: by the time MilkdownEditor sees the handle,
   * the fragment is already non-empty, so its schema-fill branch
   * never fires. Reopen paths must NOT pass this option — the
   * seed would land on top of whatever the vault load brings in. */
  ensureHandle: (slug: string, opts?: { seedFirstLine?: string }) => Promise<void>
  /** Re-read this doc's body from the vault and apply it to the
   * already-open Y.Doc. The vault watcher calls this when an external
   * edit lands on a file the app has loaded. No-op when the handle
   * isn't built yet — the next ensureHandle will hydrate from disk
   * naturally. Caller (the watcher) gates the call on the local dirty
   * flag so unsaved edits aren't clobbered. */
  reloadFromVault: (slug: string) => Promise<void>
  /** Append a doc the watcher discovered to `knownDocs`. Idempotent —
   * skips the insert when a doc with the same slug already exists,
   * so a self-write echoed back through the watcher can't double-add
   * the doc we just created. */
  addKnownDoc: (doc: KnownDoc) => void
  /** Drop a doc from the catalog because its file vanished from disk.
   * Delegates to {@link closeDoc} for the tab + handle cleanup when
   * the doc is currently open, so the existing tear-down ordering
   * (ydoc destroy, ensureNonEmptyTabStrip, etc.) is reused. */
  removeKnownDoc: (slug: string) => void
  ensureOpen: (slug: string) => void
  closeDoc: (slug: string) => string | null
  createNew: () => Promise<string>
  /** Find or create the daily entry for the given local date and make
   * it the active tab. Returns the slug. */
  openDaily: (date?: string) => Promise<string | null>
  /** Create a new writing-type note nested under `parentSlug`. The
   * parent MUST be a daily entry — writings only nest 1-deep so the
   * UI tree matches the on-disk flat layout (Karpathy wiki pattern:
   * connection via [[links]], not folder depth). Returns null when
   * the parent is anything other than a daily. Callers wanting to
   * "add a sibling" from inside a writing should resolve to the
   * writing's daily ancestor first via {@link findDailyAncestorSlug}.
   * Returns the new slug on success. */
  createChildNote: (parentSlug: string) => Promise<string | null>
  /** Create a writing child without activating its tab. Used by the
   * wikilink palette so creating a link doesn't yank the user out of
   * the parent doc mid-sentence. Same 1-deep restriction as
   * {@link createChildNote} — parent must be a daily. Seeds the
   * child's Y.Text title with the provided label so sidebar listings
   * stop showing "Untitled" for nodes the user explicitly named.
   * Returns the new slug on success, null otherwise. */
  createWritingChild: (parentSlug: string, title: string) => Promise<string | null>
  /** Walk up `parentId` from `slug` to find the nearest daily ancestor.
   * Returns its slug, or null when no daily is in the chain (orphan).
   * Used by callers of {@link createChildNote} / {@link createWritingChild}
   * who hold a non-daily slug (e.g. "+ note" pressed while a writing
   * is active) and need to resolve to the daily where the new note
   * should land. */
  findDailyAncestorSlug: (slug: string) => string | null
  /** Toggle the sidebar fold for a given doc. */
  toggleExpanded: (slug: string) => void
  reorder: (slugs: string[]) => void
  /** Archive `slug` and all its descendants (cascade). Closes any
   * open tabs in the group, tears down their handles, and reassigns
   * activeSlug if needed. The group is tagged with a single
   * timestamp so restore can move them back together. Refuses to
   * act on daily entries. Returns true on success. */
  archiveDoc: (slug: string) => string | null
  /** Restore an archived group identified by `slug` (any group
   * member works). Re-points each parentId to its pre-archive
   * value via `archivedFromParent`. */
  unarchiveDoc: (slug: string) => void
  /** Permanently delete an archived group: hits the sidecar DELETE
   * for each member, removes them from knownDocs / openSlugs /
   * handles. No-op if the slug isn't archived. */
  deleteForever: (slug: string) => Promise<string | null>
  /** Permanently delete every archived doc (sidecar + local state). */
  emptyArchive: () => Promise<string | null>
  /** Seed a new doc's body from a markdown string. Used by
   * createCustomWikiPage / ensureSystemPage to plant initial content.
   * Ensures the handle (IDB shard + Y.Doc) exists first, then applies
   * a markdown → PM → Y.Doc update under the 'doc-init' origin so the
   * seed stays out of the undo stack.
   * No-op when the markdown is empty or when the editor parser
   * isn't mounted yet (caller should retry once a doc is active). */
  seedDocBody: (slug: string, markdown: string) => Promise<boolean>
  /** Overwrite a doc's body with the supplied markdown. Unlike
   * seedDocBody this rewrites non-empty docs too — the profile
   * pipeline uses it so re-runs actually update the wiki:profile
   * page rather than no-opping. */
  replaceDocBody: (slug: string, markdown: string) => Promise<boolean>
  /** Rename a user-owned doc. Updates `knownDocs[slug].title`; the
   * auto-flush rename-on-change machinery (see `docFileSync.flushDirty`'s
   * `lastWrittenPath` branch) then moves the `.md` + `.meta.json` +
   * `.ydoc` on disk on the next tick.
   *
   * Refuses (returns false) for daily / system docs — their titles
   * are derived from type and aren't user-editable. Trim whitespace
   * and refuse empty strings; the caller's UI should validate
   * before calling, but this is a hard backstop. */
  renameDoc: (slug: string, newTitle: string) => boolean
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

/** Zustand set/get aliases shared by every slice factory. Each slice
 * file imports these and accepts `(set: SetDocsState, get: GetDocsState)`
 * — same shape zustand's StateCreator exposes, just without the
 * middleware-aware generic noise. The single argument signature
 * (callback OR partial) mirrors zustand's `set` overload exactly. */
export type SetDocsState = (
  partial:
    | Partial<DocsState>
    | ((state: DocsState) => Partial<DocsState>),
) => void
export type GetDocsState = () => DocsState

// Re-export CollabStatus so consumers can `import { type CollabStatus }
// from '@/state/docsStore'` without learning the internal hooks path.
export type { CollabStatus } from '@/hooks/useCollabDoc'
