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
import type { DocStatus } from '@/lib/docPaths'
import type { FmEntry } from '@/lib/docProperties'
import type { Template } from '@/lib/templates'

/** Slim metadata read straight from the on-disk `.meta.json` sidecar
 * (via scanVault at boot) and persisted back through the flush loop's
 * `buildMetaForKnownDoc`. Phase 5c of the Yjs-removal migration
 * retired the in-memory Y.Map('meta') that used to be the source of
 * truth — fields here ARE the source now. */
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
  type:
    | 'daily'
    | 'writing'
    | 'note'
    | `system:${string}`
    | `wiki:${string}`
  /** YYYY-MM-DD when type === 'daily'. */
  date?: string
  /** Parent doc's slug for tree-nested writing notes. Undefined for
   * roots (daily entries and any independent writing docs). */
  parentId?: string
  /** Display title for writing-type entries. Phase 5c of the
   * Yjs-removal migration retired the Y.Text('title') mirror this
   * field used to track — `title` is now the authoritative title,
   * set by `renameDoc` and persisted as the filename via the
   * rename-on-change machinery in `docFileSync.flushDirty`. Daily
   * entries don't use this — their label derives from `date`. */
  title?: string
  /** ISO timestamp recorded when the doc was first created. Phase 5b
   * of the Yjs-removal migration lifted this off `Y.Map('meta')` and
   * onto the catalog / `.meta.json` sidecar — see DocMetaFile in
   * `apps/writer-tauri/src/lib/docPaths.ts`. Absent on legacy docs
   * whose Y.Map had no createdAt either; DocumentInfoDialog renders
   * `—` in that case. */
  createdAt?: string
  /** Read-it-later source metadata. Set on captured-from-URL notes
   * (saved web pages). A present `sourceUrl` is what marks a generic
   * `note` as a read-it-later item (the old `type === 'article'` gate).
   * Populated by `createArticle` from the defuddle extraction and
   * persisted via the `.md` frontmatter so it survives restart. `readAt`
   * is set when the user marks it read; absent = unread. */
  sourceUrl?: string
  siteName?: string
  faviconUrl?: string
  description?: string
  savedAt?: string
  readAt?: string
  /** YouTube capture metadata. A present `videoId` is what marks a
   * generic `note` as a video capture (the old `type === 'youtube'`
   * gate) — it renders an inline player and picks the video icon. The
   * transcript is the body; these describe the source video. `sourceUrl`
   * (watch URL) and `siteName` (channel) reuse the fields above. */
  videoId?: string
  durationSec?: number
  thumbnailUrl?: string
  /** Vault-relative path for a generic `note` (a `.md` outside the
   * recognised folders, surfaced by the folder-tree scan). The path IS
   * the placement — pathForDoc returns it verbatim — since these files
   * live wherever the user put them. Unset on every typed doc. */
  relPath?: string
  /** Workflow status (not-started / in-progress / done). Optional; only
   * editable note types carry it (see `docSupportsStatus`). Persisted to
   * `.md` frontmatter via `buildMetaForKnownDoc` / `portableFrontmatterFields`,
   * read back by scanVault at boot. */
  status?: DocStatus
  /** Free-form tags, persisted to `.md` frontmatter as a YAML list. Empty
   * or absent when the note has none. Set via the properties panel. */
  tags?: string[]
  /** Ordered mirror of the note's on-disk frontmatter block: every
   * top-level scalar / string-list key in file order (nested maps stay
   * foreign — preserved on write, invisible here). Captured by scanVault
   * at boot and refreshed by reloadFromVault on external change. The
   * properties panel renders from it and the flush emits keys in its
   * order, so file key order IS the persisted row order. The typed
   * fields above (status/tags/createdAt/…) stay authoritative for their
   * VALUES; `fm` is authoritative for order and for custom keys. */
  fm?: FmEntry[]
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
  | 'note'          // generic user .md anywhere in the vault (folder tree + inbox captures)

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
  // Persisted (projected to PATHS on the way out — see persistConfig)
  openSlugs: string[]
  /** Transient landing field for the persisted tab strip. Rehydrate lands
   * the persisted vault-relative PATHS here (before scanVault has run, so
   * they can't be resolved yet); `bootstrap` resolves them to slugs against
   * the freshly-scanned catalog, sets `openSlugs`, and clears this. Never
   * persisted from state — `partialize` recomputes it from `openSlugs`. */
  openPaths: string[]
  knownDocs: KnownDoc[]
  /** Vault-relative paths of every folder on disk (recursive). Runtime-
   * only, rebuilt by bootstrap's scan. Lets the sidebar tree show empty
   * folders, which the file-derived tree alone can't. */
  knownFolders: string[]
  /** Vault-relative paths of every non-markdown attachment on disk
   * (pdf/png/txt/…). Runtime-only, rebuilt by bootstrap's scan and the
   * watcher's folder refresh. Surfaces read-only file rows in the tree;
   * never enters knownDocs (no slug / Yjs doc). */
  knownFiles: string[]
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
  /** One-shot restore URL for RouteSyncBridge (last-viewed doc). Runtime-only. */
  pendingRestoreUrl: string | null
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
  /** Swap a doc's relPath (and, for a renamed file, its title) in place
   * (keeps slug/tab/handle) for an external move/rename. */
  updateKnownDocPath: (slug: string, relPath: string, title?: string) => void
  /** Drop a doc from the catalog because its file vanished from disk.
   * Delegates to {@link closeDoc} for the tab + handle cleanup when
   * the doc is currently open, so the existing tear-down ordering
   * (ydoc destroy, ensureNonEmptyTabStrip, etc.) is reused. */
  removeKnownDoc: (slug: string) => void
  ensureOpen: (slug: string) => void
  closeDoc: (slug: string) => string | null
  createNew: (folderPath?: string) => Promise<string>
  /** Create a new note seeded with a template's body, then return its slug. */
  createFromTemplate: (template: Template) => Promise<string>
  /** Create a folder on disk at `relPath` and add it to knownFolders.
   * Idempotent; returns false on a filesystem error. */
  createFolder: (relPath: string) => Promise<boolean>
  /** Duplicate a generic note (same folder, "<name> copy", source body).
   * Returns the new slug or null for non-note docs. */
  duplicateDoc: (slug: string) => Promise<string | null>
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
  /** Delete a user doc by moving its file to the OS trash (recoverable)
   * and dropping it from the catalog / tabs / handles. Returns the slug
   * to navigate to next, or null. */
  deleteToTrash: (slug: string) => Promise<string | null>
  /** Delete a whole folder to the OS trash + drop contained docs from
   * the catalog/tabs/handles. Refuses folders with non-archivable docs.
   * Returns the slug to navigate to next, or null. */
  deleteFolder: (folderPath: string) => Promise<string | null>
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
  /** Move a generic `note` into `folderPath` ('' = root): keeps the
   * filename, swaps the folder part of relPath (de-duped), and lets the
   * flush move the file on disk. No-op if already there; refuses
   * non-note docs. */
  moveDocToFolder: (slug: string, folderPath: string) => boolean
  /** Rename a folder: move the directory on disk, rewrite the relPath of
   * every note inside, and update knownFolders. Refuses folders holding
   * type-derived docs (wiki/system). */
  renameFolder: (oldPath: string, newLeafName: string) => Promise<boolean>
  /** Move a folder into `destParent` ('' = root), keeping its leaf name.
   * Rejects a drop onto itself / a descendant and type-derived folders;
   * no-op if already there. */
  moveFolder: (folderPath: string, destParent: string) => Promise<boolean>
  /** Toggle a read-it-later article's read/unread state (sets/clears
   * `readAt` and flushes the sidecar). No-op for non-article docs. */
  setArticleRead: (slug: string, read: boolean) => void
  /** Set (or clear, with `undefined`) a note's workflow status and flush.
   * No-op for doc types that don't carry status (daily / system). */
  setDocStatus: (slug: string, status: DocStatus | undefined) => void
  /** Replace a note's tag list (trimmed/de-duped; empty clears) and flush. */
  setDocTags: (slug: string, tags: string[]) => void
  /** Set a property's value by panel key. Typed keys (status/tags/
   * created/…) coerce into their catalog field (invalid values are
   * rejected — no-op); custom keys upsert into `fm`. Returns false when
   * the edit was rejected. */
  setDocProperty: (slug: string, key: string, value: string | string[]) => boolean
  /** Add a new property row. Rejects empty / reserved / duplicate keys.
   * Returns false when rejected. */
  addDocProperty: (slug: string, key: string, value: string | string[]) => boolean
  /** Rename a property key in place (row position preserved). A typed
   * key de-types into a plain custom property (its control reverts to
   * text). Rejects empty / reserved / colliding names. */
  renameDocProperty: (slug: string, oldKey: string, newKey: string) => boolean
  /** Remove a property row (and clear its typed field, if any). The
   * key's line is dropped from the file on the next flush. */
  deleteDocProperty: (slug: string, key: string) => void
  /** Persist the panel's row order: materialize the full property union
   * into `fm` in the given key order. File key order follows on flush. */
  reorderDocProperties: (slug: string, orderedKeys: string[]) => void
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
