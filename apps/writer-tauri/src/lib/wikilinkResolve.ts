// Resolve [[Title]] tokens in markdown into real `[Title](note:slug)`
// links by looking up titles in the docs catalog.
//
// The editor's wikilink palette (wikilinkPalettePlugin.ts) treats
// `[[query` purely as an INPUT trigger — selecting a suggestion
// inserts a standard markdown link. There is no parse-time
// `[[Name]]` → link rewrite, so any `[[Name]]` that arrives via a
// path other than the palette (LLM-emitted content, pasted notes,
// etc.) stays as literal text in the rendered doc.
//
// This module bridges that gap for ingest content. When the user
// accepts an ingest proposal — or when the idle trigger seeds a
// brand-new page's body via createCustomWikiPage — we run the
// resolver first, turning every `[[Existing Page]]` into a proper
// `[Existing Page](note:<slug>)` markdown link. The downstream
// parser then produces a real link mark, wikilinkClickPlugin
// routes clicks, and wikilinkBrokenPlugin handles the case where
// the linked slug is later archived.
//
// Unresolved titles (no matching doc) are left as literal `[[X]]`
// so the user can spot a typo or decide to create the missing
// page manually. Better than silently absorbing the brackets.

import { useDocsStore } from '@/state/docsStore'
import { WIKILINK_HREF_PREFIX } from '@/editor/wikilinkPalettePlugin'

/** Convert every `[[Title]]` in `md` to `[Title](note:<slug>)`
 * where Title matches a live (non-archived) doc's title.
 * Case-insensitive lookup so the LLM's casing drift doesn't
 * cause silent dropouts. First match wins on title collisions —
 * collisions are rare in single-user wikis and the alternative
 * (linking to nothing) is worse UX.
 *
 * Patterns the regex deliberately does NOT match:
 *   - cross-line `[[ ... \n ... ]]` (anchored to no newline inside)
 *   - empty / whitespace-only `[[ ]]`
 *   - `[[Title|alias]]` alias syntax (out of scope; not used elsewhere) */
export function resolveWikilinksInMarkdown(md: string): string {
  const docs = useDocsStore
    .getState()
    .knownDocs.filter(
      (d) =>
        !d.archivedAt &&
        // System pages (system:conventions / log / index) are agent
        // meta surfaces — the user isn't expected to author links
        // pointing at them, and the LLM was told the same via the
        // cross-link prompt rule. Filter them out of the title →
        // slug map so an accidental `[[Conventions]]` stays as
        // literal text rather than silently routing through.
        !d.type.startsWith('system:'),
    )
  const titleToSlug = new Map<string, string>()
  for (const d of docs) {
    const title = (d.title ?? '').trim()
    if (!title) continue
    const key = title.toLowerCase()
    // First match wins — on the rare collision the older doc keeps
    // the link. Single-user wikis almost never see this; if it
    // bites someone, lint (priority 3) can flag duplicate titles.
    if (!titleToSlug.has(key)) titleToSlug.set(key, d.slug)
  }

  return md.replace(/\[\[([^\]\n]+)\]\]/g, (match, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return match
    const slug = titleToSlug.get(trimmed.toLowerCase())
    if (!slug) return match
    return `[${trimmed}](${WIKILINK_HREF_PREFIX}${slug})`
  })
}

// Dev-only handles so the wikilink resolver pipeline can be probed
// from the browser console. Useful when a rendered chat answer
// shows something unexpected (e.g. a "[blocked]" placeholder) —
// running the same input through `__resolveWikilinks` reveals
// whether the resolver matched the title or returned the raw
// `[[Title]]` for streamdown to grapple with.
//
//   __resolveWikilinks('[[Tom]]')              // see the rewrite
//   __knownDocs()                              // dump every doc's slug/title
//   __wikiTitleMap()                           // see what the resolver's
//                                              // title → slug map looks like
if (import.meta.env.DEV) {
  const w = window as unknown as {
    __resolveWikilinks: typeof resolveWikilinksInMarkdown
    __knownDocs: () => Array<{ slug: string; title: string; type: string; archived: boolean }>
    __wikiTitleMap: () => Record<string, string>
  }
  w.__resolveWikilinks = resolveWikilinksInMarkdown
  w.__knownDocs = () =>
    useDocsStore.getState().knownDocs.map((d) => ({
      slug: d.slug,
      title: d.title ?? '',
      type: d.type,
      archived: !!d.archivedAt,
    }))
  w.__wikiTitleMap = () => {
    const docs = useDocsStore
      .getState()
      .knownDocs.filter(
        (d) => !d.archivedAt && !d.type.startsWith('system:'),
      )
    const out: Record<string, string> = {}
    for (const d of docs) {
      const title = (d.title ?? '').trim()
      if (!title) continue
      const key = title.toLowerCase()
      if (!out[key]) out[key] = d.slug
    }
    return out
  }
}

/** Extract every `[[Name]]` token from a markdown body and return
 * their trimmed contents. Same regex as
 * {@link resolveWikilinksInMarkdown} — single source of truth for
 * what we consider a wikilink. Used by the wiki index builder to
 * compute backlink counts without resolving anything.
 *
 * Empty / whitespace-only brackets are skipped so a stray `[[  ]]`
 * doesn't inflate counts. Returns duplicates as duplicates: two
 * separate `[[Sarah]]` in the same body count as two backlinks (each
 * mention is its own reference to the target). */
export function extractWikilinks(md: string): string[] {
  const matches = md.matchAll(/\[\[([^\]\n]+)\]\]/g)
  const out: string[] = []
  for (const m of matches) {
    const trimmed = m[1].trim()
    if (trimmed.length > 0) out.push(trimmed)
  }
  return out
}
