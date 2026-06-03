// The ONE rulebook for tolerant anchor matching, shared by the disk
// matcher (lib/looseMatch) and the editor matcher (editor/anchorSearch)
// so the two surfaces always agree on whether an anchor resolves.
//
// Previously each side grew its own normalization (looseMatch:
// marker+colon+whitespace+trim with an indent-tolerant marker regex;
// anchorSearch: a stricter marker regex with no whitespace handling),
// and they drifted — an indented bullet or a colon-spacing difference
// resolved on disk but showed "couldn't place" in the editor. Both now
// import `canonicalizeLine`.
//
// `canonicalizeLine` is LENGTH-CHANGING and therefore comparison-only:
// callers must recover the actual text range from line boundaries (see
// `leadingMarkerLength`), never from an offset into the canonical form.

import { stripWikilinks } from './wikilinkSyntax'

/** Length (chars) of a line's leading block marker plus surrounding
 * whitespace — indent before the marker AND the space after it. 0 when
 * the line has no marker. Lets a matcher recover the content range
 * (line start + this) while comparing on the marker-stripped form. */
export function leadingMarkerLength(line: string): number {
  const m = line.match(/^\s*(?:#+|[-*+]|\d+\.|>)\s+/)
  return m ? m[0].length : 0
}

/** Canonical form of a markdown / rendered line for tolerant matching:
 *   - wikilinks → bare label (`[[Sera]]` / `[Sera](note:..)` → `Sera`)
 *   - drop the leading block marker (heading/bullet/ordered/quote),
 *     tolerant of indentation
 *   - collapse whitespace around colons (`나이 : 47` → `나이:47`)
 *   - collapse remaining whitespace runs, then trim
 * CJK-friendly: only squeezes spacing the model commonly gets wrong;
 * never joins distinct words. */
export function canonicalizeLine(line: string): string {
  const bare = stripWikilinks(line)
  return bare
    .slice(leadingMarkerLength(bare))
    .replace(/\s*:\s*/g, ':')
    .replace(/\s+/g, ' ')
    .trim()
}
