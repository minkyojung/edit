/**
 * docsStore — edit slice (rename).
 *
 * Owns the user-driven doc-rename action. Updates `knownDocs[slug]
 * .title` and forces an immediate `flushDirty()` so the on-disk
 * `.md` + `.meta.json` + `.ydoc` files rename within the same tick
 * (rather than waiting for the 2s auto-flush). The rename-on-change
 * machinery in `docFileSync.flushDirty` handles the actual atomic
 * file rename via `lastWrittenPath` tracking.
 *
 * No cross-slice calls — reads/writes `knownDocs` directly via
 * `get()`/`set()`. The `seedDocBody` action that used to live next
 * to renameDoc belongs to createSlice (initial content) instead.
 */

import { flushDirty, markSlugDirty, seedLastWrittenPath } from '@/lib/docFileSync'
import { renameVaultFile } from '@/lib/vault'
import { pathForDoc, sanitizeFilename } from '@/lib/docPaths'
import type { GetDocsState, KnownDoc, SetDocsState } from './types'

/** First free `<prefix><base>.md` (then ` 1`, ` 2`, …) not already
 * taken by another doc's relPath. `prefix` is '' for a root file or
 * 'folder/' for a file inside a folder. Excludes `selfSlug` so a
 * no-op rename (or re-case) doesn't collide with itself. */
function uniqueRelPath(
  knownDocs: KnownDoc[],
  prefix: string,
  base: string,
  selfSlug: string,
): string {
  const taken = new Set(
    knownDocs
      .filter((d) => d.slug !== selfSlug)
      .map((d) => d.relPath)
      .filter((p): p is string => Boolean(p)),
  )
  let candidate = `${prefix}${base}.md`
  let n = 1
  while (taken.has(candidate)) {
    candidate = `${prefix}${base} ${n}.md`
    n += 1
  }
  return candidate
}

export interface EditSlice {
  /** Rename a user-owned doc. For generic `note` docs the filename is
   * the label, so this changes `relPath` (same folder, new filename,
   * de-duped) and keeps `title` in sync; for writing / wiki:custom it
   * updates `title`. The auto-flush rename-on-change machinery (see
   * `docFileSync.flushDirty`'s `lastWrittenPath` branch) then moves the
   * file on disk on the next tick.
   *
   * Refuses (returns false) for daily / system docs — their titles
   * are derived from type and aren't user-editable. Trim whitespace
   * and refuse empty strings; the caller's UI should validate
   * before calling, but this is a hard backstop. */
  renameDoc: (slug: string, newTitle: string) => boolean
  /** Move a generic `note` into `folderPath` ('' = vault root): keeps
   * the filename, swaps the folder part of relPath (de-duped against the
   * target), and lets the flush rename-on-change machinery move the file
   * on disk. No-op if already there; refuses non-note docs. Returns true
   * on success. */
  moveDocToFolder: (slug: string, folderPath: string) => boolean
  /** Rename a folder: move the directory on disk (one atomic rename),
   * rewrite the relPath of every doc inside it, and update knownFolders
   * (parent + nested). `oldPath` is the folder's vault-relative path,
   * `newLeafName` the new last segment. No-op if unchanged; returns
   * false on a filesystem error. */
  renameFolder: (oldPath: string, newLeafName: string) => Promise<boolean>
  /** Toggle the read/unread state of a read-it-later article. Sets
   * `readAt` to now when marking read, clears it (undefined) when
   * marking unread, then flushes so the `.meta.json` sidecar reflects
   * the change immediately. No-op for non-article docs. */
  setArticleRead: (slug: string, read: boolean) => void
}

export const createEditSlice = (
  set: SetDocsState,
  get: GetDocsState,
): EditSlice => ({
  renameDoc: (slug, newTitle) => {
    const trimmed = newTitle.trim()
    if (trimmed.length === 0) return false
    const idx = get().knownDocs.findIndex((d) => d.slug === slug)
    if (idx < 0) return false
    const cur = get().knownDocs[idx]

    // Generic notes: the filename IS the sidebar label, so a rename
    // changes the file's path (same folder, new filename) — not just
    // `title`. Keep both in sync: relPath drives the disk path + the
    // tree label, title drives tabs / palette. The flushDirty
    // rename-on-change machinery moves the file on disk.
    if (cur.type === 'note') {
      const safe = sanitizeFilename(trimmed)
      const slash = cur.relPath?.lastIndexOf('/') ?? -1
      const prefix =
        cur.relPath && slash >= 0 ? cur.relPath.slice(0, slash + 1) : ''
      if (cur.relPath === `${prefix}${safe}.md`) return true
      const newRelPath = uniqueRelPath(get().knownDocs, prefix, safe, slug)
      const list = [...get().knownDocs]
      list[idx] = { ...cur, relPath: newRelPath, title: safe }
      set({ knownDocs: list })
      markSlugDirty(slug)
      void flushDirty()
      return true
    }

    // Only user-editable doc types can be renamed. Daily titles are
    // derived from date; system page titles are derived from the
    // type suffix.
    const eligible =
      cur.type === 'writing' || cur.type.startsWith('wiki:custom-')
    if (!eligible) return false
    if (cur.title === trimmed) return true
    const list = [...get().knownDocs]
    list[idx] = { ...cur, title: trimmed }
    set({ knownDocs: list })
    // Mark dirty + fire an immediate flush so the rename lands on
    // disk right away. The 2s timer-based flush would also catch it
    // eventually, but for an explicit user action the UI expectation
    // is that Finder reflects the change now, not 2s later.
    markSlugDirty(slug)
    void flushDirty()
    return true
  },

  moveDocToFolder: (slug, folderPath) => {
    const idx = get().knownDocs.findIndex((d) => d.slug === slug)
    if (idx < 0) return false
    const cur = get().knownDocs[idx]
    // Only generic notes carry a free-form relPath; daily / writing /
    // wiki / system docs have type-derived locations and don't move.
    if (cur.type !== 'note' || !cur.relPath) return false
    const base = cur.relPath.split('/').pop() ?? cur.relPath
    const stem = base.replace(/\.md$/, '')
    const prefix = folderPath ? `${folderPath}/` : ''
    if (cur.relPath === `${prefix}${base}`) return true // already there
    const newRelPath = uniqueRelPath(get().knownDocs, prefix, stem, slug)
    const list = [...get().knownDocs]
    list[idx] = { ...cur, relPath: newRelPath }
    set({ knownDocs: list })
    // The flush's lastWrittenPath branch detects the changed path and
    // moves the file on disk (handles a different folder, not just a
    // renamed file). Fire it now so the move lands promptly.
    markSlugDirty(slug)
    void flushDirty()
    return true
  },

  renameFolder: async (oldPath, newLeafName) => {
    const safe = sanitizeFilename(newLeafName)
    const slash = oldPath.lastIndexOf('/')
    const parent = slash >= 0 ? oldPath.slice(0, slash + 1) : ''
    let newPath = `${parent}${safe}`
    if (newPath === oldPath) return true

    const oldPrefix = `${oldPath}/`
    const bySlug = new Map(get().knownDocs.map((d) => [d.slug, d]))
    const getDoc = (s: string) => bySlug.get(s)
    const affected = get().knownDocs.filter((d) => {
      const p = pathForDoc(d, getDoc)
      return !!p && p.startsWith(oldPrefix)
    })
    // Folders holding type-derived docs (wiki/system) can't be renamed
    // by rewriting relPath — refuse rather than leave them dangling.
    if (affected.some((d) => d.type !== 'note' || !d.relPath)) return false

    // Dedupe against an existing folder of the same target name.
    const folders = new Set(get().knownFolders)
    let n = 1
    while (folders.has(newPath)) {
      newPath = `${parent}${safe} ${n}`
      n += 1
    }

    // Flush pending edits to the OLD paths first so no doc inside is
    // dirty during the directory rename (a stray flush would otherwise
    // recreate the old folder by writing to the pre-move path).
    await flushDirty()
    try {
      await renameVaultFile(oldPath, newPath)
    } catch (err) {
      console.error('[docs] renameFolder failed', err)
      return false
    }

    // Rewrite the relPath of every note under the folder, and re-seed
    // the flush rename-tracker to the new paths so it won't try to move
    // the (already-moved) files again.
    const seeds: Array<{ slug: string; mdRel: string }> = []
    const list = get().knownDocs.map((d) => {
      if (!d.relPath || !d.relPath.startsWith(oldPrefix)) return d
      const newRel = `${newPath}/${d.relPath.slice(oldPrefix.length)}`
      seeds.push({ slug: d.slug, mdRel: newRel })
      return { ...d, relPath: newRel }
    })
    set({ knownDocs: list })
    seedLastWrittenPath(seeds)
    set((s) => ({
      knownFolders: s.knownFolders.map((f) =>
        f === oldPath
          ? newPath
          : f.startsWith(oldPrefix)
            ? `${newPath}/${f.slice(oldPrefix.length)}`
            : f,
      ),
    }))
    return true
  },

  setArticleRead: (slug, read) => {
    const idx = get().knownDocs.findIndex((d) => d.slug === slug)
    if (idx < 0) return
    const cur = get().knownDocs[idx]
    // Read/unread is a read-it-later concept — only captured-from-URL
    // notes (saved pages / youtube) have a `sourceUrl`.
    if (!cur.sourceUrl) return
    const readAt = read ? new Date().toISOString() : undefined
    if (cur.readAt === readAt) return
    const list = [...get().knownDocs]
    // Explicit `readAt` (even when undefined) so buildMetaForKnownDoc
    // writes the cleared value through mergeSidecar — same trick the
    // archive unarchive path uses to drop a sidecar field.
    list[idx] = { ...cur, readAt }
    set({ knownDocs: list })
    markSlugDirty(slug)
    void flushDirty()
  },
})
