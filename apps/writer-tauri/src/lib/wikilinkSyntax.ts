// Pure wikilink-syntax helpers — no store / editor dependencies, so any
// layer (the markdown matcher, the editor anchor resolver, the wikilink
// resolver) can share them without pulling in the catalog store.

/** Reduce both wikilink forms to their bare label text:
 *   `[[Title]]`            → `Title`
 *   `[Title](note:<slug>)` → `Title`
 *
 * This bridges the two representations of the same line: on-disk /
 * `bodyMarkdown` and the LLM's anchor carry `[[Title]]`, while the
 * editor's RENDERED text carries only `Title` (the link is a mark, not
 * visible brackets). Anchor matching strips both sides to this common
 * label form so a wikilink-bearing line resolves regardless of which
 * form it came from. One source of truth for what a wikilink looks
 * like, shared by lib/looseMatch (disk apply) and editor/anchorSearch
 * (editor placement) so the two never disagree. */
export function stripWikilinks(text: string): string {
  return text
    .replace(/\\?\[\\?\[([^\]\n]+?)\\?\]\\?\]/g, (_m, name: string) => name.trim())
    .replace(/\[([^\]\n]+)\]\(note:[^)]+\)/g, (_m, label: string) => label)
}
