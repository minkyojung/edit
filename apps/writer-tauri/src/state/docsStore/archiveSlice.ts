/**
 * docsStore — delete slice.
 *
 * Two user-driven destructive paths, both recoverable via the OS Trash:
 *   - deleteToTrash — move a doc's `.md` to the OS trash
 *   - deleteFolder  — move a whole folder to the OS trash
 *
 * Both respect Karpathy write-ownership: only docs the user owns
 * (daily-spawned writings + user-created wiki:custom-*) reach these
 * paths. Daily entries and agent-managed wiki/system pages are refused
 * before any state mutation. Trash-first ordering: the on-disk move
 * happens BEFORE in-memory teardown, so a failed trash never leaves the
 * catalog and disk disagreeing.
 *
 * Cross-slice access:
 *   - `get().ensureHandle(slug)` — handlesSlice (warming the new active doc)
 *   - `get().openDaily()` — createSlice (fallback when a delete drains the strip)
 *
 * Shared helper: `ensureNonEmptyTabStrip` (helpers.ts) — keeps the tab
 * strip from going blank when a destructive action clears it.
 */

import { notify } from '@/lib/notify'
import { useChatRuns } from '@/stores/chatRuns'
import { markSlugDirty, clearDirty } from '@/lib/docFileSync'
import { trashVaultFile } from '@/lib/vault'
import { pathForDoc } from '@/lib/docPaths'
import { ensureNonEmptyTabStrip, getDocPolicy, isUserOwnedWiki, isWikiDoc } from './helpers'
import type { DocsState, GetDocsState, SetDocsState } from './types'

export interface ArchiveSlice {
  /** Delete a user doc by moving its `.md` to the OS
   * trash (recoverable) and dropping it from the catalog,
   * tabs, and handles. Returns the slug to navigate to next, or null.
   * Refuses daily / system / agent-managed pages. */
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
  deleteToTrash: async (slug) => {
    const state = get()
    const target = state.knownDocs.find((d) => d.slug === slug)
    if (!target) return null
    // Ownership gate: daily spine, system pages, and agent-managed wiki
    // are never user-deletable.
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
