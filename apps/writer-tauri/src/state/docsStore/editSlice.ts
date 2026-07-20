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

import {
  flushDirty,
  markPropertiesDirty,
  markSlugDirty,
  seedLastWrittenPath,
} from '@/lib/docFileSync'
import { renameVaultFile } from '@/lib/vault'
import { pathForDoc, sanitizeFilename, type DocStatus } from '@/lib/docPaths'
import {
  clearTypedFieldPatch,
  effectiveEntries,
  RESERVED_PROPERTY_KEYS,
  TYPED_KEY_TO_META,
  typedFieldPatch,
  type FmEntry,
  type TypedPanelKey,
} from '@/lib/docProperties'
import { planFolderMove } from '@/lib/folderMove'
import { updateWikilinksForRename } from '@/lib/renameWikilinks'
import { normalizeTags } from '@/lib/tags'
import { docSupportsStatus } from './helpers'
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

/** Move the folder at `oldPath` to `desiredNewPath`: one atomic disk
 * rename, then rewrite every derived bit of state (contained docs'
 * relPath, the flush rename-tracker, and knownFolders — parent + nested).
 * De-dupes the destination against an existing folder of the same name
 * (` 1`, ` 2`, …). Shared by renameFolder (parent kept, leaf changes) and
 * moveFolder (leaf kept, parent changes) so the subtle flush/seed
 * ordering lives in exactly one place. Returns false when the folder
 * holds type-derived docs (wiki/system) that can't be relocated by
 * rewriting relPath, or on a filesystem error. No-op (true) if unchanged. */
async function relocateFolder(
  set: SetDocsState,
  get: GetDocsState,
  oldPath: string,
  desiredNewPath: string,
): Promise<boolean> {
  if (desiredNewPath === oldPath) return true

  const oldPrefix = `${oldPath}/`
  const bySlug = new Map(get().knownDocs.map((d) => [d.slug, d]))
  const getDoc = (s: string) => bySlug.get(s)
  const affected = get().knownDocs.filter((d) => {
    const p = pathForDoc(d, getDoc)
    return !!p && p.startsWith(oldPrefix)
  })
  // Folders holding type-derived docs (wiki/system) can't be moved by
  // rewriting relPath — refuse rather than leave them dangling.
  if (affected.some((d) => d.type !== 'note' || !d.relPath)) return false

  // Dedupe against an existing folder of the same target name.
  const slash = desiredNewPath.lastIndexOf('/')
  const parent = slash >= 0 ? desiredNewPath.slice(0, slash + 1) : ''
  const leaf = desiredNewPath.slice(slash + 1)
  const folders = new Set(get().knownFolders)
  let newPath = desiredNewPath
  let n = 1
  while (folders.has(newPath)) {
    newPath = `${parent}${leaf} ${n}`
    n += 1
  }

  // Flush pending edits to the OLD paths first so no doc inside is dirty
  // during the directory rename (a stray flush would otherwise recreate
  // the old folder by writing to the pre-move path).
  await flushDirty()
  try {
    await renameVaultFile(oldPath, newPath)
  } catch (err) {
    console.error('[docs] relocateFolder failed', err)
    return false
  }

  // Rewrite the relPath of every note under the folder, and re-seed the
  // flush rename-tracker to the new paths so it won't try to move the
  // (already-moved) files again.
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
  /** Move a folder into `destParent` ('' = vault root), keeping its leaf
   * name. Shares relocateFolder with renameFolder. Rejects (false) a drop
   * onto the folder itself or one of its descendants, and folders holding
   * type-derived docs; no-op (true) if already under destParent. */
  moveFolder: (folderPath: string, destParent: string) => Promise<boolean>
  /** Toggle the read/unread state of a read-it-later article. Sets
   * `readAt` to now when marking read, clears it (undefined) when
   * marking unread, then flushes so the `.meta.json` sidecar reflects
   * the change immediately. No-op for non-article docs. */
  setArticleRead: (slug: string, read: boolean) => void
  /** Set (or clear, with `undefined`) a note's workflow status, then
   * flush so the `.md` frontmatter reflects it immediately. No-op for
   * doc types that don't carry status (daily / system). */
  setDocStatus: (slug: string, status: DocStatus | undefined) => void
  /** Replace a note's tag list (trimmed, de-duped; empty clears the field),
   * then flush. No-op for doc types that don't carry metadata. */
  setDocTags: (slug: string, tags: string[]) => void
  /** Set a property's value by panel key. Typed keys coerce into their
   * catalog field (invalid values rejected → false); custom keys upsert
   * into `fm` (new keys append at the end). */
  setDocProperty: (slug: string, key: string, value: string | string[]) => boolean
  /** Add a new property row. Rejects empty / reserved / duplicate keys. */
  addDocProperty: (slug: string, key: string, value: string | string[]) => boolean
  /** Rename a property key in place (row position preserved). A typed key
   * de-types into a plain custom property carrying its current value. */
  renameDocProperty: (slug: string, oldKey: string, newKey: string) => boolean
  /** Remove a property row and clear its typed field, if any. */
  deleteDocProperty: (slug: string, key: string) => void
  /** Persist the panel's row order into `fm` (file key order on flush). */
  reorderDocProperties: (slug: string, orderedKeys: string[]) => void
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
      // Rewrite `[[oldName]]` → `[[newName]]` across the vault so inbound
      // wikilinks follow the rename (Obsidian behaviour). Async so it never
      // blocks the rename UI.
      void updateWikilinksForRename(slug, cur.title ?? '', safe)
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
    // Follow inbound wikilinks across the vault (see the note branch above).
    void updateWikilinksForRename(slug, cur.title ?? '', trimmed)
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
    // Same parent, new leaf — relocateFolder handles the disk rename,
    // child relPath rewrite, dedupe, and knownFolders update.
    return relocateFolder(set, get, oldPath, `${parent}${safe}`)
  },

  moveFolder: async (folderPath, destParent) => {
    // Cycle guard (into self / own descendant) + leaf-keeping newPath are
    // decided by the pure planner; relocateFolder does the rest.
    const plan = planFolderMove(folderPath, destParent)
    if (plan.kind === 'reject') return false
    if (plan.kind === 'noop') return true
    return relocateFolder(set, get, folderPath, plan.newPath)
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
    // Property mutation → ordered flush branch, so this write can't
    // shuffle a panel-ordered frontmatter block back to append-order.
    markPropertiesDirty(slug)
    void flushDirty()
  },

  setDocStatus: (slug, status) => {
    const idx = get().knownDocs.findIndex((d) => d.slug === slug)
    if (idx < 0) return
    const cur = get().knownDocs[idx]
    // Daily journals and system pages don't carry a workflow status.
    if (!docSupportsStatus(cur)) return
    if (cur.status === status) return
    const list = [...get().knownDocs]
    // Explicit `status` (even when undefined) so buildMetaForKnownDoc
    // writes the cleared value through mergeSidecar — same trick
    // setArticleRead uses to drop a field.
    list[idx] = { ...cur, status }
    set({ knownDocs: list })
    markSlugDirty(slug)
    markPropertiesDirty(slug)
    void flushDirty()
  },

  setDocTags: (slug, tags) => {
    const idx = get().knownDocs.findIndex((d) => d.slug === slug)
    if (idx < 0) return
    const cur = get().knownDocs[idx]
    if (!docSupportsStatus(cur)) return
    const next = normalizeTags(tags)
    const prev = cur.tags ?? []
    if (prev.length === next.length && prev.every((t, i) => t === next[i])) return
    const list = [...get().knownDocs]
    // Empty → undefined so buildMetaForKnownDoc drops the `tags:` block.
    list[idx] = { ...cur, tags: next.length ? next : undefined }
    set({ knownDocs: list })
    markSlugDirty(slug)
    markPropertiesDirty(slug)
    void flushDirty()
  },

  setDocProperty: (slug, key, value) => {
    const idx = get().knownDocs.findIndex((d) => d.slug === slug)
    if (idx < 0) return false
    const cur = get().knownDocs[idx]
    if (!docSupportsStatus(cur)) return false
    const trimmedKey = key.trim()
    if (!trimmedKey) return false
    let patch: Partial<KnownDoc>
    if (trimmedKey in TYPED_KEY_TO_META) {
      // Typed key: coerce into the authoritative catalog field. fm needs
      // no touch — the flush re-injects typed values from the field, and
      // effectiveEntries places a not-yet-present key canonically.
      const typed = typedFieldPatch(trimmedKey as TypedPanelKey, value)
      if (!typed) return false
      patch = typed as Partial<KnownDoc>
    } else {
      // Custom key: upsert into fm (append at the end when new — the
      // Notion "add at the bottom" position).
      const fm: FmEntry[] = [...(cur.fm ?? [])]
      const at = fm.findIndex((e) => e.key === trimmedKey)
      if (at >= 0) fm[at] = { key: trimmedKey, value }
      else fm.push({ key: trimmedKey, value })
      patch = { fm }
    }
    const list = [...get().knownDocs]
    list[idx] = { ...cur, ...patch }
    set({ knownDocs: list })
    markSlugDirty(slug)
    markPropertiesDirty(slug)
    void flushDirty()
    return true
  },

  addDocProperty: (slug, key, value) => {
    const idx = get().knownDocs.findIndex((d) => d.slug === slug)
    if (idx < 0) return false
    const cur = get().knownDocs[idx]
    if (!docSupportsStatus(cur)) return false
    const trimmedKey = key.trim()
    if (!trimmedKey || RESERVED_PROPERTY_KEYS.includes(trimmedKey)) return false
    // Duplicate = already a row in the panel's effective view (covers
    // both fm entries and typed fields that carry a value).
    const taken = effectiveEntries(cur.fm, cur).some((e) => e.key === trimmedKey)
    if (taken) return false
    return get().setDocProperty(slug, trimmedKey, value)
  },

  renameDocProperty: (slug, oldKey, newKey) => {
    const idx = get().knownDocs.findIndex((d) => d.slug === slug)
    if (idx < 0) return false
    const cur = get().knownDocs[idx]
    if (!docSupportsStatus(cur)) return false
    const nextKey = newKey.trim()
    if (!nextKey || nextKey === oldKey) return false
    if (RESERVED_PROPERTY_KEYS.includes(nextKey)) return false
    // Materialize the effective view so a typed key that isn't in fm yet
    // (status set via the badge, never panel-placed) can still be renamed
    // at the position the panel shows it in.
    const entries = effectiveEntries(cur.fm, cur)
    const at = entries.findIndex((e) => e.key === oldKey)
    if (at < 0) return false
    if (entries.some((e) => e.key === nextKey)) return false
    const fm = [...entries]
    // The entry's value was re-injected from the typed field by
    // effectiveEntries, so de-typing hands the CURRENT value over to the
    // now-custom key; clearTypedFieldPatch drops the old typed field.
    fm[at] = { key: nextKey, value: fm[at].value }
    const list = [...get().knownDocs]
    list[idx] = { ...cur, fm, ...(clearTypedFieldPatch(oldKey) as Partial<KnownDoc>) }
    set({ knownDocs: list })
    markSlugDirty(slug)
    markPropertiesDirty(slug)
    void flushDirty()
    return true
  },

  deleteDocProperty: (slug, key) => {
    const idx = get().knownDocs.findIndex((d) => d.slug === slug)
    if (idx < 0) return
    const cur = get().knownDocs[idx]
    if (!docSupportsStatus(cur)) return
    const fm = effectiveEntries(cur.fm, cur).filter((e) => e.key !== key)
    const list = [...get().knownDocs]
    // The flush claims every scalar key of the on-disk block, so a key
    // absent from fm (and from the typed fields) has its line dropped —
    // deletion sticks without a tombstone.
    list[idx] = { ...cur, fm, ...(clearTypedFieldPatch(key) as Partial<KnownDoc>) }
    set({ knownDocs: list })
    markSlugDirty(slug)
    markPropertiesDirty(slug)
    void flushDirty()
  },

  reorderDocProperties: (slug, orderedKeys) => {
    const idx = get().knownDocs.findIndex((d) => d.slug === slug)
    if (idx < 0) return
    const cur = get().knownDocs[idx]
    if (!docSupportsStatus(cur)) return
    // Materialize the full union in the requested order. Panel rows the
    // caller omitted (shouldn't happen, but never lose data over it)
    // keep their relative order at the end.
    const byKey = new Map(effectiveEntries(cur.fm, cur).map((e) => [e.key, e]))
    const fm: FmEntry[] = []
    for (const key of orderedKeys) {
      const entry = byKey.get(key)
      if (!entry) continue
      fm.push(entry)
      byKey.delete(key)
    }
    fm.push(...byKey.values())
    const list = [...get().knownDocs]
    list[idx] = { ...cur, fm }
    set({ knownDocs: list })
    markSlugDirty(slug)
    markPropertiesDirty(slug)
    void flushDirty()
  },
})
