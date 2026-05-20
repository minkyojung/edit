/**
 * docsStore — doc creation slice.
 *
 * Owns the six user-driven doc-creation paths plus the small helper
 * (`findDailyAncestorSlug`) that callers use to anchor "+ note from
 * inside a writing" onto a daily parent. Body-seeding for ingest
 * (system pages, wiki content) lives here too — same lifecycle
 * "make a doc exist, then optionally fill it" pattern.
 *
 * Cross-slice access:
 *   - `get().ensureHandle(slug, opts?)` — handlesSlice
 *   - `scrubDailyTitleArtifacts` — handlesSlice export
 *
 * Karpathy invariant: writings nest only 1-deep under a daily. Both
 * `createChildNote` and `createWritingChild` reject non-daily parents
 * so the disk layout stays flat (Karpathy wiki pattern: [[links]] not
 * folder depth). Callers holding a non-daily slug must resolve to the
 * daily ancestor first via `findDailyAncestorSlug`.
 */

import { generateClientSlug } from '@/lib/slug'
import { todayLocalDate, writeDocMeta } from '@/hooks/useDocMeta'
import { deriveLabel } from '@/lib/docLabel'
import { replaceMarkdownInYDoc, seedMarkdownIntoYDoc } from '@/lib/seedMarkdown'
import { useEditorViewStore } from '../editorViewStore'
import { scrubDailyTitleArtifacts } from './handlesSlice'
import type { GetDocsState, KnownDoc, SetDocsState } from './types'

export interface CreateSlice {
  /** Empty writing note. Label falls back to 'Untitled' until the
   * user names it via the inline title input. */
  createNew: () => Promise<void>
  /** Find or create the daily entry for the given local date and
   * make it the active tab. Returns the slug (or null on edge cases
   * the caller treats as no-op). */
  openDaily: (date?: string) => Promise<string | null>
  /** Create a child writing note under a daily parent. See the
   * 1-deep restriction in the module docstring. */
  createChildNote: (parentSlug: string) => Promise<string | null>
  /** Wikilink palette path: same as createChildNote but seeds the
   * body's first paragraph with the supplied title text so the new
   * doc opens with the wikilink name. */
  createWritingChild: (parentSlug: string, title: string) => Promise<string | null>
  /** Walk up parentId from `slug` to find the nearest daily ancestor.
   * Returns its slug, or null when the chain doesn't reach a daily. */
  findDailyAncestorSlug: (slug: string) => string | null
  /** Apply a markdown string as the initial body of a doc. Used by
   * ingest paths (system pages, wiki content) that need to plant
   * content into a freshly-created handle. No-op on already-populated
   * bodies. */
  seedDocBody: (slug: string, markdown: string) => Promise<boolean>
  /** Overwrite a doc's entire body with the supplied markdown.
   * Unlike {@link seedDocBody} this does NOT skip on non-empty docs —
   * existing content is cleared and replaced. Used by the profile
   * pipeline so re-runs (or single-section regenerations that
   * assemble a fresh full markdown) can actually update the page. */
  replaceDocBody: (slug: string, markdown: string) => Promise<boolean>
}

export const createCreateSlice = (
  set: SetDocsState,
  get: GetDocsState,
): CreateSlice => ({
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
    await get().ensureHandle(slug)
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
    await get().ensureHandle(slug)
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
    // Refuse to nest under something we don't know about — keeps the
    // tree from sprouting orphan branches if we get a stale slug
    // from the UI.
    const parent = get().knownDocs.find((d) => d.slug === parentSlug)
    if (!parent) return null
    // Writings only nest 1-deep under a daily. Wiki pages are roots.
    // Anything else (including another writing) is refused — the
    // Karpathy wiki pattern relies on flat-on-disk + [[link]]
    // connections rather than folder depth. Callers holding a
    // non-daily slug (e.g. ⌘N pressed while a writing is active)
    // must resolve to the writing's daily ancestor first via
    // findDailyAncestorSlug.
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
    await get().ensureHandle(slug)
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
    // Empty body — the title comes from the palette input.
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
    // store, so MilkdownEditor never sees an empty fragment and its
    // schema-fill branch can't race with this seed. The 'doc-init'
    // transaction origin keeps the seed out of the undo stack so
    // Cmd+Z right after opening doesn't strip the name.
    await get().ensureHandle(slug, { seedFirstLine: title })
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

  seedDocBody: async (slug, markdown) => {
    if (!markdown.trim()) return false
    await get().ensureHandle(slug)
    const handle = get().handles[slug]
    if (!handle) return false
    // Wait for the vault load chain to complete before reading or
    // writing the fragment. Without this we race: the read path
    // (deriveLabel below) sees an empty fragment, the seed lands a
    // fresh update, and the vault-loaded content that arrives
    // microseconds later merges in alongside it.
    await handle.contentReady
    const parser = useEditorViewStore.getState().parser
    if (!parser) {
      // Caller is responsible for retrying once a parser is available
      // (e.g. after mounting any doc). We log instead of throw so the
      // calling ingest pipeline doesn't crash.
      console.warn('[docs] seedDocBody: parser not ready, skipping', slug)
      return false
    }
    // Don't double-seed. The check looks at user-visible text, not
    // raw XML. fragment.toString() returns wrappers like
    // `<paragraph></paragraph>` for the schema's empty-doc fill, so a
    // naive trim().length > 0 would skip every doc that's been opened
    // once. deriveLabel walks Y.XmlText.toDelta inserts only — a non-
    // empty result means real text exists.
    const labelText = deriveLabel(handle.ydoc.getXmlFragment('prosemirror'))
    if (labelText.length > 0) return false
    return seedMarkdownIntoYDoc(handle.ydoc, markdown, parser)
  },

  replaceDocBody: async (slug, markdown) => {
    if (!markdown.trim()) return false
    await get().ensureHandle(slug)
    const handle = get().handles[slug]
    if (!handle) return false
    // Same readiness wait as seedDocBody — the rewrite races vault
    // hydration otherwise and the replace can land mid-load, leaving
    // the page in a mixed state on next render.
    await handle.contentReady
    const parser = useEditorViewStore.getState().parser
    if (!parser) {
      console.warn('[docs] replaceDocBody: parser not ready, skipping', slug)
      return false
    }
    return replaceMarkdownInYDoc(handle.ydoc, markdown, parser)
  },
})
