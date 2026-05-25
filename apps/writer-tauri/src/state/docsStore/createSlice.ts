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
import {
  applyMarkdownToEditor,
  replaceMarkdownInYDoc,
  seedMarkdownIntoYDoc,
} from '@/lib/seedMarkdown'
import { useEditorViewStore } from '../editorViewStore'
import { getActiveSlugFromHash } from '@/lib/viewUrl'
import { scrubDailyTitleArtifacts } from './handlesSlice'
import type { GetDocsState, KnownDoc, SetDocsState } from './types'

export interface CreateSlice {
  /** Empty writing note. Label falls back to 'Untitled' until the
   * user names it via the inline title input. Returns the new slug
   * so callers can drive the post-create navigation themselves
   * (URL is the source of truth — the store no longer sets activeSlug
   * on its own). */
  createNew: () => Promise<string>
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
    // Anchor the new writing under today's daily. `type: 'writing'`
    // has no disk placement of its own — `pathForDoc` walks parentId
    // up to a daily ancestor to derive `daily/<date>/<title>.md`, and
    // returns null when no daily is found. Pre-fix this slice created
    // `{ type: 'writing' }` with no parentId, which meant pathForDoc
    // returned null, flushDirty silently skipped the doc, and the
    // brand-new note never reached disk — so it vanished on restart.
    //
    // Going through openDaily + createChildNote reuses the existing
    // daily-anchoring logic (including handle warmup + writeDocMeta
    // for the daily so its `daily/<date>.md` lands on disk too — the
    // boot scan needs that file to resolve the writing's parentId on
    // next session).
    //
    // Side effect worth noting: openDaily adds today's daily to the
    // tab strip if it wasn't already there. Calling code (the "+ tab"
    // button in EditorTabs) then navigates to the returned slug — the
    // new writing, not the daily — so the user lands where they
    // expected. The visible daily tab is a deliberate context cue
    // ("you created this under today").
    const dailySlug = await get().openDaily()
    if (!dailySlug) {
      throw new Error('createNew: failed to anchor under today\'s daily')
    }
    const slug = await get().createChildNote(dailySlug)
    if (!slug) {
      throw new Error('createNew: createChildNote refused')
    }
    return slug
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
    const handle = get().handles[slug]
    if (handle) {
      if (!handle.ydoc.getMap('meta').get('type')) {
        // Y.Map write kept for the Phase 5b dual-write window so any
        // surface still reading from Y.Map sees the value too. Phase
        // 5c retires the Y.Map writes; the `KnownDoc.createdAt` above
        // is the durable source via `buildMetaForKnownDoc`.
        writeDocMeta(handle.ydoc, {
          type: 'daily',
          date: targetDate,
          createdAt: known.createdAt,
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
    const handle = get().handles[slug]
    if (handle) {
      // Dual-write window — see openDaily for the same Phase 5b
      // rationale.
      writeDocMeta(handle.ydoc, {
        type: 'writing',
        parentId: parentSlug,
        createdAt,
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
    // store, so MilkdownEditor never sees an empty fragment and its
    // schema-fill branch can't race with this seed. The 'doc-init'
    // transaction origin keeps the seed out of the undo stack so
    // Cmd+Z right after opening doesn't strip the name.
    await get().ensureHandle(slug, { seedFirstLine: title })
    const handle = get().handles[slug]
    if (handle) {
      // Dual-write window — see openDaily for the same Phase 5b
      // rationale.
      writeDocMeta(handle.ydoc, {
        type: 'writing',
        parentId: parentSlug,
        createdAt,
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
    // Active-editor branch: when the slug we're seeding is the doc
    // the user is currently viewing, write to PM directly so the
    // mount-time hydrate's pre-Phase-3 assumption doesn't strand the
    // seed inside a Y.Doc that no longer mirrors PM. Inactive slugs
    // (e.g. background wiki page creation from a chat ingest pass)
    // still go through Y.Doc — the next mount picks them up via
    // MilkdownEditor's `yXmlFragmentToProseMirrorRootNode` hydrate.
    const activeView = activeViewForSlug(slug)
    // Phase 5a of the Yjs-removal migration: keep `handle.bodyMarkdown`
    // synchronised with whichever path lands. The cache feeds the
    // mount-time hydrate (when the user reopens this slug later) and
    // the 3 inactive-doc readers (ingest / idle / wiki) that step 5
    // migrates off the Y.Doc fragment.
    handle.bodyMarkdown = markdown
    if (activeView) {
      return applyMarkdownToEditor(activeView, markdown, parser)
    }
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
    // Active-editor branch — same rationale as seedDocBody above.
    // Profile rebuilds and wiki ingest rewrites that target the
    // user's current view land via PM dispatch; everything else
    // stages into Y.Doc for the next mount.
    const activeView = activeViewForSlug(slug)
    // See seedDocBody for the bodyMarkdown rationale.
    handle.bodyMarkdown = markdown
    if (activeView) {
      return applyMarkdownToEditor(activeView, markdown, parser)
    }
    return replaceMarkdownInYDoc(handle.ydoc, markdown, parser)
  },
})

/** Returns the live PM EditorView when, and only when, it belongs to
 * `slug`. The view in `editorViewStore` is whichever doc is currently
 * mounted; comparing against the URL-derived active slug is the
 * cheapest way to make sure a background-ingest write doesn't land
 * in a foreground editor for a different doc. Returns null whenever
 * the slug isn't active or no editor is mounted. */
function activeViewForSlug(slug: string) {
  if (getActiveSlugFromHash() !== slug) return null
  return useEditorViewStore.getState().view
}
