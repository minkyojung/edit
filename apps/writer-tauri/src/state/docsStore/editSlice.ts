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

import { flushDirty, markSlugDirty } from '@/lib/docFileSync'
import type { GetDocsState, SetDocsState } from './types'

export interface EditSlice {
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
})
