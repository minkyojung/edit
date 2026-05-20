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
import { ensureNonEmptyTabStrip, getDocPolicy, isUserOwnedWiki, isWikiDoc } from './helpers'
import type { DocsState, GetDocsState, KnownDoc, SetDocsState } from './types'

export interface ArchiveSlice {
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
  /** Permanently delete an archived group. No-op if the slug isn't
   * archived. */
  deleteForever: (slug: string) => Promise<void>
  /** Permanently delete every archived doc. */
  emptyArchive: () => Promise<void>
}

export const createArchiveSlice = (
  set: SetDocsState,
  get: GetDocsState,
): ArchiveSlice => ({
  archiveDoc: (slug) => {
    const state = get()
    const target = state.knownDocs.find((d) => d.slug === slug)
    if (!target) return false
    // Daily entries are time-axis spine, not user-authored docs.
    // Refuse so the sidebar/breadcrumb invariants stay intact.
    if (target.type === 'daily') return false
    // Policy-level gate. canArchive=false catches system pages AND
    // wiki:profile (which IS user-owned for editing/banner purposes
    // but must survive accidental archive — it's the user's clone
    // memory, losing it = catastrophic).
    if (!getDocPolicy(target).canArchive) return false
    // Defense-in-depth (Karpathy write-ownership): agent-managed
    // pages without user ownership are also blocked, even if a
    // future policy row mis-sets canArchive.
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
    // Cancel chat runs for the whole cascade before tearing handles
    // down. Late proposals must not race past a destroyed ydoc.
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

    // The empty-strip invariant uses the *post-archive* catalog (so
    // today's daily must still be archive-free in nextKnown). Pass a
    // synthesized state so the lookup sees nextKnown.
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
      get().ensureHandle(finalActive).catch((err) =>
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
  },

  deleteForever: async (slug) => {
    const state = get()
    const target = state.knownDocs.find((d) => d.slug === slug)
    if (!target?.archivedAt) return
    // Agent-managed wiki/system pages can't reach this code path
    // today (archive is refused above) but assert it anyway so a
    // future regression can't silently wipe agent memory. User-
    // spawned wiki:custom-* pages reach archive, so they're allowed
    // through here and follow normal hard-delete.
    if (isWikiDoc(target) && !isUserOwnedWiki(target)) return
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
    set(ensureNonEmptyTabStrip(postState, {
      knownDocs: nextKnown,
      openSlugs: nextOpen,
      expandedDocSlugs: nextExpanded,
    }))
    if (failed > 0) {
      notify.cantDeleteNote({ onRetry: () => get().deleteForever(slug) })
    }
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
