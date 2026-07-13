/**
 * docsStore — archive / restore / delete slice.
 *
 * Four user-driven destructive paths plus the cascade helper:
 *   - archiveDoc       — soft delete (cascade to descendants)
 *   - unarchiveDoc     — restore a batch by its shared timestamp
 *   - deleteForever    — hard delete one archived batch
 *   - emptyArchive     — hard delete every archived doc
 *
 * All four respect Karpathy write-ownership: only docs the user owns
 * (daily-spawned writings + user-created wiki:custom-*) reach these
 * paths. Daily entries and agent-managed wiki/system pages are
 * refused before any state mutation.
 *
 * Cross-slice access:
 *   - `get().ensureHandle(slug)` — handlesSlice (post-archive
 *     warming of the new active doc)
 *   - `get().openDaily()` — createSlice (fallback when emptyArchive
 *     drains the open-strip)
 *
 * Shared helper: `ensureNonEmptyTabStrip` (helpers.ts) — keeps the
 * tab strip from going blank when a destructive action clears it.
 *
 * File-local helper: `collectDescendantSlugs` (BFS) — only archiveDoc
 * uses it.
 */

import { notify } from '@/lib/notify'
import { useChatRuns } from '@/stores/chatRuns'
import { flushDirty, markSlugDirty, clearDirty } from '@/lib/docFileSync'
import { trashVaultFile } from '@/lib/vault'
import { pathForDoc } from '@/lib/docPaths'
import { ensureNonEmptyTabStrip, getDocPolicy, isUserOwnedWiki, isWikiDoc } from './helpers'
import type { DocsState, GetDocsState, KnownDoc, SetDocsState } from './types'

export interface ArchiveSlice {
  /** Archive `slug` and all its descendants (cascade). Closes any
   * open tabs in the group, tears down their handles, and reassigns
   * the post-archive active slug. The group is tagged with a single
   * timestamp so restore can move them back together. Refuses to
   * act on daily entries.
   *
   * Returns the slug the caller should navigate to after the archive,
   * or null when the action was refused (gate failed). When the
   * archive succeeded but no slug remains (corner case — empty-strip
   * invariant didn't fire because catalog has no today's daily yet),
   * the caller may stay put. */
  archiveDoc: (slug: string) => string | null
  /** Restore an archived group identified by `slug` (any group
   * member works). Re-points each parentId to its pre-archive
   * value via `archivedFromParent`. */
  unarchiveDoc: (slug: string) => void
  /** Permanently delete an archived group. Returns the post-delete
   * active slug for the caller's navigate, or null if no slug
   * needs surfacing (the deleted group wasn't open). */
  deleteForever: (slug: string) => Promise<string | null>
  /** Permanently delete every archived doc. Returns the post-empty
   * active slug for the caller's navigate, or null if the tab strip
   * was untouched. */
  emptyArchive: () => Promise<string | null>
  /** Delete a user doc by moving its `.md` to the OS
   * trash (recoverable) and dropping it from the catalog,
   * tabs, and handles. Returns the slug to navigate to next, or null.
   * Refuses daily / system / agent-managed pages (same gate as
   * archiveDoc). */
  deleteToTrash: (slug: string) => Promise<string | null>
  /** Delete a whole folder: move the directory to the OS trash and drop
   * every doc inside it from the catalog / tabs / handles. Returns the
   * slug to navigate to next, or null. Refuses folders that contain
   * non-archivable docs (wiki:profile / system pages). */
  deleteFolder: (folderPath: string) => Promise<string | null>
}

export const createArchiveSlice = (
  set: SetDocsState,
  get: GetDocsState,
): ArchiveSlice => ({
  archiveDoc: (slug) => {
    const state = get()
    const target = state.knownDocs.find((d) => d.slug === slug)
    if (!target) return null
    // Daily entries are time-axis spine, not user-authored docs.
    // Refuse so the sidebar/breadcrumb invariants stay intact.
    if (target.type === 'daily') return null
    // Policy-level gate. canArchive=false catches system pages AND
    // wiki:profile (which IS user-owned for editing/banner purposes
    // but must survive accidental archive — it's the user's clone
    // memory, losing it = catastrophic).
    if (!getDocPolicy(target).canArchive) return null
    // Defense-in-depth (Karpathy write-ownership): agent-managed
    // pages without user ownership are also blocked, even if a
    // future policy row mis-sets canArchive.
    if (isWikiDoc(target) && !isUserOwnedWiki(target)) return null
    if (target.archivedAt) return null

    const groupSlugs = collectDescendantSlugs(state.knownDocs, slug)
    const stamp = Date.now()
    const groupSet = new Set(groupSlugs)

    // Close any open tabs in the group and destroy their handles.
    // We also pre-compute a sensible "next active" slug for the
    // caller's post-archive navigate. The archived doc is treated as
    // if it were the user's focus (whether or not it actually was),
    // since the most common archive UX is "I'm done with this thing,
    // archive it and put me on the next sensible tab."
    const nextOpen = state.openSlugs.filter((s) => !groupSet.has(s))
    const archivedIdx = state.openSlugs.indexOf(slug)
    const nextActive: string | null =
      archivedIdx >= 0
        ? state.openSlugs.slice(archivedIdx + 1).find((s) => !groupSet.has(s)) ??
          [...state.openSlugs.slice(0, archivedIdx)].reverse().find((s) => !groupSet.has(s)) ??
          null
        : nextOpen[0] ?? null
    // Cancel chat runs for the whole cascade before tearing handles
    // down. Late proposals must not race past a destroyed handle.
    const chatRuns = useChatRuns.getState()
    for (const s of groupSlugs) {
      chatRuns.abortBySlug(s)
    }
    const nextHandles = { ...state.handles }
    const nextStatus = { ...state.status }
    for (const s of groupSlugs) {
      const h = nextHandles[s]
      if (h) {
        h.destroy()
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

    // The empty-strip invariant uses the *post-archive* catalog (so
    // today's daily must still be archive-free in nextKnown). Pass a
    // synthesized state so the lookup sees nextKnown.
    const postState: DocsState = { ...state, knownDocs: nextKnown }
    const patch = ensureNonEmptyTabStrip(postState, {
      knownDocs: nextKnown,
      openSlugs: nextOpen,
      handles: nextHandles,
      status: nextStatus,
    })
    set(patch)
    // Sidecar writes go through the flush path so the flush stays the
    // single writer of `.meta.json` (no read-modify-write races with
    // the periodic auto-flush). Marking the cascade dirty and kicking
    // the flush immediately gives "click → disk" the same latency as
    // the previous direct write, but with no concurrent writer.
    //
    // `findDailyAncestor` falls back to `archivedFromParent` when
    // `parentId` is cleared (which `set(patch)` just did), so the
    // flush's `metaPathForDoc` still resolves to the writing's
    // on-disk location.
    for (const s of groupSlugs) {
      markSlugDirty(s)
    }
    void flushDirty().catch((err) =>
      console.error('[docs] post-archive flush failed', err),
    )
    // If the invariant promoted today's daily into the strip the
    // patch carries that as openSlugs[0]; use it as the next active
    // when our pre-computed neighbor is null.
    const postOpen = patch.openSlugs ?? nextOpen
    const finalActive = nextActive ?? postOpen[0] ?? null
    if (finalActive && !get().handles[finalActive]) {
      get().ensureHandle(finalActive).catch((err) =>
        console.error('[docs] post-archive ensureHandle failed', err),
      )
    }
    return finalActive
  },

  unarchiveDoc: (slug) => {
    const state = get()
    const target = state.knownDocs.find((d) => d.slug === slug)
    if (!target?.archivedAt) return
    const stamp = target.archivedAt
    // Capture pre-mutation group so we know whose sidecar to clear —
    // after `set` the archivedAt is gone, the predicate that selected
    // the cascade can't reuse.
    const groupSlugs = state.knownDocs
      .filter((d) => d.archivedAt === stamp)
      .map((d) => d.slug)
    // Restore everything archived in the same batch (same timestamp)
    // so a cascade is undone as a unit.
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
    // Same routing as archiveDoc: mark dirty and let the flush write
    // the cleared sidecar. `buildMetaForKnownDoc` reads the post-set
    // KnownDoc — archivedAt/archivedFromParent are now undefined, so
    // the merged sidecar drops them on JSON.stringify and the doc
    // boots back as live.
    for (const s of groupSlugs) {
      markSlugDirty(s)
    }
    void flushDirty().catch((err) =>
      console.error('[docs] post-unarchive flush failed', err),
    )
  },

  deleteForever: async (slug) => {
    const state = get()
    const target = state.knownDocs.find((d) => d.slug === slug)
    if (!target?.archivedAt) return null
    // Agent-managed wiki/system pages can't reach this code path
    // today (archive is refused above) but assert it anyway so a
    // future regression can't silently wipe agent memory. User-
    // spawned wiki:custom-* pages reach archive, so they're allowed
    // through here and follow normal hard-delete.
    if (isWikiDoc(target) && !isUserOwnedWiki(target)) return null
    const stamp = target.archivedAt
    const groupSlugs = state.knownDocs
      .filter((d) => d.archivedAt === stamp)
      .map((d) => d.slug)
    // Path C: no IDB shards to clean. Vault file deletion is the
    // only durable cleanup needed, but that's not wired yet — the
    // user removes files from Finder if they want the disk freed.
    const failed = 0
    const groupSet = new Set(groupSlugs)
    const cur = get()
    const nextKnown = cur.knownDocs.filter((d) => !groupSet.has(d.slug))
    const nextOpen = cur.openSlugs.filter((sl) => !groupSet.has(sl))
    const nextExpanded = cur.expandedDocSlugs.filter((sl) => !groupSet.has(sl))
    const postState: DocsState = { ...cur, knownDocs: nextKnown }
    const patch = ensureNonEmptyTabStrip(postState, {
      knownDocs: nextKnown,
      openSlugs: nextOpen,
      expandedDocSlugs: nextExpanded,
    })
    set(patch)
    if (failed > 0) {
      notify.cantDeleteNote({ onRetry: () => get().deleteForever(slug) })
    }
    // The post-patch openSlugs holds the new strip; caller navigates
    // to its head when the active doc was inside the deleted group.
    return (patch.openSlugs ?? nextOpen)[0] ?? null
  },

  emptyArchive: async () => {
    const archived = get().knownDocs.filter((d) => d.archivedAt)
    if (archived.length === 0) return null
    // Path C: no IDB shards to clean. Vault files stay on disk —
    // user removes them from Finder if they want the space back.
    const failed = 0
    const archivedSet = new Set(archived.map((d) => d.slug))
    const cur = get()
    const nextKnown = cur.knownDocs.filter((d) => !archivedSet.has(d.slug))
    const nextOpen = cur.openSlugs.filter((sl) => !archivedSet.has(sl))
    const nextExpanded = cur.expandedDocSlugs.filter((sl) => !archivedSet.has(sl))
    const postState: DocsState = { ...cur, knownDocs: nextKnown }
    const patch = ensureNonEmptyTabStrip(postState, {
      knownDocs: nextKnown,
      openSlugs: nextOpen,
      expandedDocSlugs: nextExpanded,
    })
    set(patch)
    if (get().openSlugs.length === 0) {
      void get().openDaily().catch((err) =>
        console.error('[docs] post-emptyArchive openDaily failed', err),
      )
    }
    if (failed > 0) {
      notify.cantEmptyTrash({ onRetry: () => get().emptyArchive() })
    }
    return (patch.openSlugs ?? nextOpen)[0] ?? null
  },

  deleteToTrash: async (slug) => {
    const state = get()
    const target = state.knownDocs.find((d) => d.slug === slug)
    if (!target) return null
    // Same ownership gate as archiveDoc: daily spine, system pages, and
    // agent-managed wiki are never user-deletable.
    if (target.type === 'daily') return null
    if (!getDocPolicy(target).canArchive) return null
    if (isWikiDoc(target) && !isUserOwnedWiki(target)) return null

    // Resolve the on-disk path BEFORE removing the doc — pathForDoc
    // walks the catalog to derive a writing's location.
    const bySlug = new Map(state.knownDocs.map((d) => [d.slug, d]))
    const rel = pathForDoc(target, (s) => bySlug.get(s))

    // Do the recoverable OS-trash move FIRST; only tear down in-memory state
    // AFTER it succeeds. The old order dropped the doc from knownDocs before
    // the async trash, so a failed trash (e.g. the hardened-runtime AppleEvent
    // block that made delete a no-op in the packaged app) left the catalog and
    // disk disagreeing: the sidebar row vanished while the file lingered, so a
    // follow-up Finder delete couldn't resolve the now-unknown slug and later
    // edits to the doc were silently dropped by the flush ("!known → clear").
    // Abort any run and clear the dirty flag first so a concurrent flush tick
    // can't re-persist the file we're about to trash.
    useChatRuns.getState().abortBySlug(slug)
    clearDirty(slug)
    if (rel) {
      try {
        await trashVaultFile(rel)
        await trashVaultFile(rel.replace(/\.md$/, '.meta.json'))
      } catch (err) {
        console.error('[docs] deleteToTrash move failed', err)
        // Nothing was torn down — the doc is fully intact and still editable.
        // Re-mark dirty so any unsaved edits still flush, then bail.
        markSlugDirty(slug)
        notify.cantDeleteNote({ onRetry: () => get().deleteToTrash(slug) })
        return slug
      }
    }

    // Trash succeeded (or there was no on-disk file) — tear down in-memory now.
    const live = get()
    const nextHandles = { ...live.handles }
    const nextStatus = { ...live.status }
    nextHandles[slug]?.destroy()
    delete nextHandles[slug]
    delete nextStatus[slug]

    const nextOpen = live.openSlugs.filter((s) => s !== slug)
    const nextExpanded = live.expandedDocSlugs.filter((s) => s !== slug)
    const nextKnown = live.knownDocs.filter((d) => d.slug !== slug)
    const postState: DocsState = { ...live, knownDocs: nextKnown }
    const patch = ensureNonEmptyTabStrip(postState, {
      knownDocs: nextKnown,
      openSlugs: nextOpen,
      expandedDocSlugs: nextExpanded,
      handles: nextHandles,
      status: nextStatus,
    })
    set(patch)

    const finalActive = (patch.openSlugs ?? nextOpen)[0] ?? null
    if (finalActive && !get().handles[finalActive]) {
      get().ensureHandle(finalActive).catch((err) =>
        console.error('[docs] post-delete ensureHandle failed', err),
      )
    }
    return finalActive
  },

  deleteFolder: async (folderPath) => {
    const state = get()
    const prefix = `${folderPath}/`
    const bySlug = new Map(state.knownDocs.map((d) => [d.slug, d]))
    const getDoc = (s: string) => bySlug.get(s)
    const affected = state.knownDocs.filter((d) => {
      const p = pathForDoc(d, getDoc)
      return !!p && p.startsWith(prefix)
    })
    // Protect agent-managed / non-archivable docs (wiki:profile, system
    // pages): refuse to delete a folder that contains them.
    if (affected.some((d) => !getDocPolicy(d).canArchive)) return null

    const group = new Set(affected.map((d) => d.slug))

    // Trash the whole folder FIRST; tear down in-memory only on success (same
    // ordering fix as deleteToTrash — a failed trash must never leave the
    // catalog and disk disagreeing). Abort runs and clear dirty flags up front
    // so a concurrent flush can't re-persist a doc inside the folder we're
    // trashing.
    for (const d of affected) {
      useChatRuns.getState().abortBySlug(d.slug)
      clearDirty(d.slug)
    }
    try {
      await trashVaultFile(folderPath)
    } catch (err) {
      console.error('[docs] deleteFolder move failed', err)
      // Nothing torn down — folder + docs stay intact. Re-mark dirty so any
      // unsaved edits still flush, then bail without changing the active doc.
      for (const d of affected) markSlugDirty(d.slug)
      notify.cantDeleteNote({ onRetry: () => get().deleteFolder(folderPath) })
      return get().openSlugs[0] ?? null
    }

    // Trash succeeded — tear down every contained doc (mirrors deleteToTrash).
    const live = get()
    const nextHandles = { ...live.handles }
    const nextStatus = { ...live.status }
    for (const d of affected) {
      nextHandles[d.slug]?.destroy()
      delete nextHandles[d.slug]
      delete nextStatus[d.slug]
    }
    const nextOpen = live.openSlugs.filter((s) => !group.has(s))
    const nextExpanded = live.expandedDocSlugs.filter((s) => !group.has(s))
    const nextKnown = live.knownDocs.filter((d) => !group.has(d.slug))
    const nextFolders = live.knownFolders.filter(
      (f) => f !== folderPath && !f.startsWith(prefix),
    )
    const postState: DocsState = { ...live, knownDocs: nextKnown }
    const patch = ensureNonEmptyTabStrip(postState, {
      knownDocs: nextKnown,
      openSlugs: nextOpen,
      expandedDocSlugs: nextExpanded,
      handles: nextHandles,
      status: nextStatus,
      knownFolders: nextFolders,
    })
    set(patch)

    const finalActive = (patch.openSlugs ?? nextOpen)[0] ?? null
    if (finalActive && !get().handles[finalActive]) {
      get().ensureHandle(finalActive).catch((err) =>
        console.error('[docs] post-delete-folder ensureHandle failed', err),
      )
    }
    return finalActive
  },
})

// ── File-local helpers ──────────────────────────────────────────────

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
