/**
 * docsStore — doc creation slice.
 *
 * Owns the six user-driven doc-creation paths plus the small helper
 * (`findDailyAncestorSlug`) that callers use to anchor "+ note from
 * inside a writing" onto a daily parent. Body-seeding for ingest
 * (system pages, wiki content) lives here too — same lifecycle
 * "make a doc exist, then optionally fill it" pattern.
 *
 * Phase 5c of the Yjs-removal migration retired the per-handle
 * Y.Doc: type / date / parentId / createdAt all live on the
 * `KnownDoc` catalog (serialised to `.meta.json` by the flush
 * loop), and body seeding writes to `handle.bodyMarkdown` for
 * inactive docs or dispatches into PM for the active view.
 *
 * Karpathy invariant: writings nest only 1-deep under a daily. Both
 * `createChildNote` and `createWritingChild` reject non-daily parents
 * so the disk layout stays flat (Karpathy wiki pattern: [[links]] not
 * folder depth). Callers holding a non-daily slug must resolve to the
 * daily ancestor first via `findDailyAncestorSlug`.
 */

import { generateClientSlug } from '@/lib/slug'
import { todayLocalDate } from '@/hooks/useDocMeta'
import { flushDirty, markSlugDirty } from '@/lib/docFileSync'
import { createVaultFolder, readVaultFile } from '@/lib/vault'
import { splitFrontmatter } from '@/lib/frontmatter'
import { updateDocBody } from './docBody'
import { interpolate, CURSOR_TOKEN } from '@/lib/interpolate'
import type { Template } from '@/lib/templates'
import type { GetDocsState, KnownDoc, SetDocsState } from './types'

export interface CreateSlice {
  /** Empty writing note. Label falls back to 'Untitled' until the
   * user names it via the inline title input. Returns the new slug
   * so callers can drive the post-create navigation themselves
   * (URL is the source of truth — the store no longer sets activeSlug
   * on its own). */
  createNew: () => Promise<string>
  /** Create a new note seeded with a template's body. Same placement +
   * lifecycle as {@link createNew} (blank `inbox/Untitled.md`), then the
   * template body is seeded in. Returns the new slug for post-create
   * navigation. */
  createFromTemplate: (template: Template) => Promise<string>
  /** Create a folder on disk at `relPath` and add it to knownFolders so
   * the sidebar tree shows it immediately. Idempotent. Returns false on
   * a filesystem error. */
  createFolder: (relPath: string) => Promise<boolean>
  /** Duplicate a generic `note`: a copy in the same folder named
   * "<name> copy" (de-duped), with the source body. Returns the new
   * slug (or null for non-note docs). */
  duplicateDoc: (slug: string) => Promise<string | null>
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

/** First free inbox path for a new untitled note: `inbox/Untitled.md`,
 * then `inbox/Untitled 1.md`, `inbox/Untitled 2.md`, … so two quick
 * ⌘N presses don't collide on the same file. */
function uniqueInboxPath(knownDocs: KnownDoc[]): string {
  const taken = new Set(
    knownDocs.map((d) => d.relPath).filter((p): p is string => Boolean(p)),
  )
  let candidate = 'inbox/Untitled.md'
  let n = 1
  while (taken.has(candidate)) {
    candidate = `inbox/Untitled ${n}.md`
    n += 1
  }
  return candidate
}

export const createCreateSlice = (
  set: SetDocsState,
  get: GetDocsState,
): CreateSlice => ({
  createNew: async () => {
    // Flat Obsidian-style note: a plain `note` lands at
    // `inbox/<name>.md`. (The vault is now a flat tree — the old
    // "anchor every new note under today's daily as a `writing`"
    // model was retired.) For `note` docs `relPath` is the only
    // placement rule pathForDoc knows; without it pathForDoc returns
    // null, flushDirty skips the doc, and the brand-new note never
    // reaches disk — so we always set relPath here.
    const slug = generateClientSlug()
    const createdAt = new Date().toISOString()
    const relPath = uniqueInboxPath(get().knownDocs)
    const meta: KnownDoc = {
      slug,
      type: 'note',
      // Filename (sans `inbox/` + `.md`) is the sidebar label; keep
      // title in sync so CommandPalette / tabs show the same name.
      title: relPath.slice('inbox/'.length).replace(/\.md$/, ''),
      relPath,
      createdAt,
    }
    set((s) => ({
      knownDocs: [...s.knownDocs, meta],
      openSlugs: s.openSlugs.includes(slug)
        ? s.openSlugs
        : [...s.openSlugs, slug],
    }))
    await get().ensureHandle(slug)
    // Force the (empty) note to disk now so it survives a restart even
    // before the first edit — mirrors createArticle's explicit flush.
    markSlugDirty(slug)
    void flushDirty()
    return slug
  },

  createFromTemplate: async (template) => {
    // Reuse createNew's placement + flush lifecycle (blank inbox note), then
    // seed the template body. seedDocBody only fills empty docs, so the fresh
    // note takes the body cleanly; the seed is cached before the caller
    // navigates, so the editor mounts already populated.
    //
    // Tokens are interpolated at create time. {{cursor}} has no meaning here (no
    // live caret) so it's just stripped.
    const body = interpolate(template.body).split(CURSOR_TOKEN).join('')
    const slug = await get().createNew()
    await get().seedDocBody(slug, body)
    return slug
  },

  createFolder: async (relPath) => {
    // Optimistic: show the folder in the tree immediately, then create
    // it on disk in the background (the mkdir IPC round-trip — slower on
    // iCloud — would otherwise delay the row appearing). Roll back the
    // optimistic add if the disk op fails.
    set((s) => ({
      knownFolders: s.knownFolders.includes(relPath)
        ? s.knownFolders
        : [...s.knownFolders, relPath],
    }))
    try {
      await createVaultFolder(relPath)
      return true
    } catch (err) {
      console.error('[docs] createFolder failed', err)
      set((s) => ({
        knownFolders: s.knownFolders.filter((f) => f !== relPath),
      }))
      return false
    }
  },

  duplicateDoc: async (slug) => {
    const src = get().knownDocs.find((d) => d.slug === slug)
    if (src?.type !== 'note' || !src.relPath) return null
    const dir = src.relPath.includes('/')
      ? src.relPath.slice(0, src.relPath.lastIndexOf('/') + 1)
      : ''
    const stem = (src.relPath.split('/').pop() ?? '').replace(/\.md$/, '')
    // First free "<stem> copy.md", then " copy 2", …
    const taken = new Set(
      get().knownDocs.map((d) => d.relPath).filter((p): p is string => Boolean(p)),
    )
    let relPath = `${dir}${stem} copy.md`
    let n = 2
    while (taken.has(relPath)) {
      relPath = `${dir}${stem} copy ${n}.md`
      n += 1
    }
    // Copy the source body (strip its frontmatter — the copy mints a
    // fresh slug).
    let body = ''
    try {
      body = splitFrontmatter(await readVaultFile(src.relPath)).body
    } catch (err) {
      console.warn('[docs] duplicateDoc read failed', err)
    }
    const newSlug = generateClientSlug()
    const meta: KnownDoc = {
      slug: newSlug,
      type: 'note',
      title: relPath.slice(dir.length).replace(/\.md$/, ''),
      relPath,
      createdAt: new Date().toISOString(),
    }
    set((s) => ({
      knownDocs: [...s.knownDocs, meta],
      openSlugs: s.openSlugs.includes(newSlug)
        ? s.openSlugs
        : [...s.openSlugs, newSlug],
    }))
    await get().ensureHandle(newSlug)
    if (body.trim()) {
      try {
        await get().seedDocBody(newSlug, body)
      } catch (err) {
        console.warn('[docs] duplicateDoc seed failed', err)
      }
    }
    markSlugDirty(newSlug)
    void flushDirty()
    return newSlug
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
      const createdAt = new Date().toISOString()
      known = { slug, type: 'daily', date: targetDate, createdAt }
      set((s) => ({ knownDocs: [...s.knownDocs, known!] }))
    }
    const slug = known.slug
    if (!get().openSlugs.includes(slug)) {
      set((s) => ({ openSlugs: [...s.openSlugs, slug] }))
    }
    await get().ensureHandle(slug)
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
    const createdAt = new Date().toISOString()
    const meta: KnownDoc = {
      slug,
      type: 'writing',
      parentId: parentSlug,
      createdAt,
    }
    set((s) => ({
      knownDocs: [...s.knownDocs, meta],
      openSlugs: s.openSlugs.includes(slug)
        ? s.openSlugs
        : [...s.openSlugs, slug],
    }))
    await get().ensureHandle(slug)
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
    const createdAt = new Date().toISOString()
    const meta: KnownDoc = {
      slug,
      type: 'writing',
      parentId: parentSlug,
      title,
      createdAt,
    }
    set((s) => ({ knownDocs: [...s.knownDocs, meta] }))
    // Seed the body's first paragraph with the wikilink text via
    // ensureHandle's seedFirstLine option. Critical: the seed runs
    // *inside* ensureHandle, before the handle is published to the
    // store, so MilkdownEditor never sees an empty `bodyMarkdown`
    // cache and its mount-time hydrate paints the seed straight into
    // PM. markSlugDirty (inside seedBodyFirstLine) kicks the flush
    // tick so the seed reaches `.md` on disk even if the user never
    // types.
    await get().ensureHandle(slug, { seedFirstLine: title })
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
    // Seed only when the body is still empty. The "already has content" guard
    // lives inside the transform: returning `prev` unchanged is a no-op skip,
    // so `changed` is false and we report "didn't seed". The funnel owns the
    // hydration wait, per-slug serialization, live-editor push, and dirty-mark.
    const result = await updateDocBody(
      slug,
      (prev) => (prev.trim().length > 0 ? prev : markdown),
      { source: 'seed' },
    )
    return result.ok && result.changed
  },

  replaceDocBody: async (slug, markdown) => {
    if (!markdown.trim()) return false
    // Wholesale rewrite (profile rebuilds, wiki ingest). The funnel handles
    // hydration/serialization/editor-push/dirty; it also now refuses to
    // overwrite a doc with an unresolved external conflict (reports ok:false).
    const result = await updateDocBody(slug, () => markdown, { source: 'local' })
    return result.ok
  },
})

