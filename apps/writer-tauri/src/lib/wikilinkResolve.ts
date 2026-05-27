// Wikilink representation roundtrip helpers. Two directions:
//
//   - `resolveWikilinksInMarkdown` (expand): `[[Title]]` →
//     `[Title](note:<slug>)`. Used at the EDITOR PARSE boundary
//     (Phase L1) so PM internally sees a regular link mark and the
//     existing wikilinkClickPlugin / wikilinkBrokenPlugin / palette
//     surfaces all work without learning a new node type.
//
//   - `condenseWikilinksInMarkdown` (collapse): `[Title](note:<slug>)`
//     → `[[Title]]`. Used at the EDITOR SERIALIZE boundary so disk
//     and `handle.bodyMarkdown` carry the `[[Title]]` form. This is
//     the canonical wikilink shape — what the LLM reads, what the
//     applier matches against, what the user sees verbatim if they
//     open the .md file outside the app.
//
// Symmetric wrapping at parser+serializer means every consumer of
// `useEditorViewStore.getState().{parser, serializer}` benefits
// automatically — dirtyTrackerPlugin, applyToWikiPage, reload
// flows, etc. PM stays standards-compliant, disk stays
// Obsidian-style, and the two never drift.
//
// Unresolved titles (no matching doc) are left as literal `[[X]]`
// during expand so the user can spot a typo or decide to create
// the missing page manually. Better than silently absorbing the
// brackets.

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

  // The optional `\\?` slots accept commonmark's `\[` / `\]` escape
  // form. Standard markdown serializers (including the one Milkdown
  // ships) escape `[[` to `\[\[` to prevent later parsers from
  // tripping on the double bracket as malformed-link syntax. Disk
  // content that survived a PM roundtrip carries those backslashes;
  // matching them here lets L1's parse-time expand recognise the
  // wikilink anyway, so the editor renders it as a real link and the
  // next serialize sweep emits a clean `[[X]]` form without escapes.
  return md.replace(
    /\\?\[\\?\[([^\]\n]+?)\\?\]\\?\]/g,
    (match, name: string) => {
      const trimmed = name.trim()
      if (!trimmed) return match
      const slug = titleToSlug.get(trimmed.toLowerCase())
      if (!slug) return match
      return `[${trimmed}](${WIKILINK_HREF_PREFIX}${slug})`
    },
  )
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

/** Collapse `[Text](note:<slug>)` markdown-link form back to
 * `[[Text]]` wikilink form. The inverse of
 * {@link resolveWikilinksInMarkdown}. Phase L1 wraps the editor's
 * serializer with this so `handle.bodyMarkdown` and the on-disk
 * `.md` file carry the canonical `[[Text]]` shape — the same shape
 * the LLM reads, the same shape the applier matches against, the
 * same shape a user sees if they open the file in another editor.
 *
 * The label text the link carries (`[Text]`) is preserved as the
 * `[[Text]]` body. We do NOT cross-reference the catalog here —
 * the slug already lived in the link's href, so the title-to-slug
 * mapping has been honoured by whichever code emitted the link
 * (wikilink palette, `resolveWikilinksInMarkdown`). Trying to
 * "validate" the title against the catalog at serialize time would
 * just open a race window where a rename mid-serialize could
 * strip a valid wikilink.
 *
 * Non-`note:` href links are left alone — they're regular markdown
 * URLs and stay in `[Text](url)` form. */
export function condenseWikilinksInMarkdown(md: string): string {
  // Match `[label](note:slug)` — non-greedy label, href starts with
  // `note:`. Stops at the first `)` to keep the regex linear; that's
  // fine because our wikilink slugs never contain a literal `)`.
  return md.replace(
    /\[([^\]\n]+)\]\(note:[^)]+\)/g,
    (_match, label: string) => `[[${label}]]`,
  )
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
  // Same escape-aware pattern as `resolveWikilinksInMarkdown` so the
  // backlink counter sees the same set of wikilinks the renderer
  // does. Pre-L1 disk content with `\[\[X\]\]` shouldn't drop out of
  // the index just because of escape backslashes.
  const matches = md.matchAll(/\\?\[\\?\[([^\]\n]+?)\\?\]\\?\]/g)
  const out: string[] = []
  for (const m of matches) {
    const trimmed = m[1].trim()
    if (trimmed.length > 0) out.push(trimmed)
  }
  return out
}
