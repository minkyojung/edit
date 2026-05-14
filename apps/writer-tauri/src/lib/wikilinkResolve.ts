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
