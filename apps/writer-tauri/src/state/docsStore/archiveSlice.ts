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
    let nextActive: string | null =
      archivedIdx >= 0
        ? state.openSlugs.slice(archivedIdx + 1).find((s) => !groupSet.has(s)) ??
          [...state.openSlugs.slice(0, archivedIdx)].reverse().find((s) => !groupSet.has(s)) ??
          null
        : nextOpen[0] ?? null
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
    const patch = ensureNonEmptyTabStrip(postState, {
      knownDocs: nextKnown,
      openSlugs: nextOpen,
      handles: nextHandles,
      status: nextStatus,
    })
    set(patch)
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
