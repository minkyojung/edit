// Zone markers on the wiki:profile page.
//
// The page is shared between several writers:
//
//   - the profile pipeline (this directory) writes the derivation
//     sections — Voice, Themes, About
//   - the ingest pipeline (agent/ingest) appends facts the user
//     mentioned in dailies, into ## Background
//   - the user types freely in ## Notes
//
// Markers are HTML comments so the rendered editor view hides them
// (the underlying ProseMirror/Milkdown markdown render strips comment
// nodes). The code side parses them as plain text — every read and
// every partial write goes through replaceZone / readZone, so a
// future change to the marker format (e.g. adding zone ids) is a
// single-file edit.
//
// Why the start/end pair, not one tag: a self-closing marker would
// require the reader to scan forward and guess where the zone ends.
// Explicit end markers keep the parsing deterministic and survive
// the user accidentally typing inside the zone (rare, but the marker
// pair lets us detect it).

import type { ProfileSectionKey } from './conventions'
import { PROFILE_SECTIONS } from './conventions'

const SECTION_ORDER: ProfileSectionKey[] = ['voice', 'themes', 'about']

export function startMarker(kind: ProfileSectionKey): string {
  return `<!-- derived:${kind} start -->`
}

export function endMarker(kind: ProfileSectionKey): string {
  return `<!-- derived:${kind} end -->`
}

export interface DerivationInput {
  kind: ProfileSectionKey
  content: string
}

export interface SourceLink {
  title: string
  sourceUrl: string
}

/** Compose the full wiki:profile markdown from the persisted
 * derivations plus a Sources list. Output layout:
 *
 *   <derived:voice>   ## Voice + body    </derived:voice>
 *   <derived:themes>  ## Themes + body   </derived:themes>
 *   <derived:about>   ## About + body    </derived:about>
 *   ## Sources
 *   - …
 *   ## Background    (empty — ingest appends here over time)
 *   ## Notes         (empty — user-owned area)
 *
 * Empty Background / Notes are explicit so the ingest LLM and the
 * user both have a stable target heading on day one (rather than
 * the heading appearing only after the first append). */
export function assembleProfileMarkdown(
  derivations: DerivationInput[],
  sources: SourceLink[],
): string {
  const sectionsByKind = new Map(derivations.map((d) => [d.kind, d.content]))
  const blocks: string[] = []

  for (const kind of SECTION_ORDER) {
    const content = sectionsByKind.get(kind)
    if (!content) continue
    const heading = PROFILE_SECTIONS[kind].heading
    blocks.push(
      [
        startMarker(kind),
        `${heading}\n\n${content.trim()}`,
        endMarker(kind),
      ].join('\n'),
    )
  }

  if (sources.length > 0) {
    blocks.push(
      ['## Sources', sources.map((s) => `- [${s.title}](${s.sourceUrl})`).join('\n')].join('\n\n'),
    )
  }

  // Background and Notes are intentionally empty headings. The
  // ingest LLM (per conventions) appends bullets into Background;
  // the user types freely under Notes. Day-one stub keeps the
  // zone contract visible.
  blocks.push('## Background')
  blocks.push('## Notes')

  return blocks.join('\n\n') + '\n'
}

/** Splice a single zone's body in an existing wiki:profile markdown.
 * The replacement preserves whatever's outside the zone (other
 * derivations, Background, Notes, the user's manual edits).
 *
 * Returns null when the zone markers can't be found — caller should
 * treat that as "fall back to a full rebuild" rather than silently
 * dropping the write. */
export function replaceZone(
  markdown: string,
  kind: ProfileSectionKey,
  newContent: string,
): string | null {
  const start = startMarker(kind)
  const end = endMarker(kind)
  const startIdx = markdown.indexOf(start)
  if (startIdx === -1) return null
  const endIdx = markdown.indexOf(end, startIdx + start.length)
  if (endIdx === -1) return null

  const heading = PROFILE_SECTIONS[kind].heading
  const replacement = `${start}\n${heading}\n\n${newContent.trim()}\n${end}`
  return markdown.slice(0, startIdx) + replacement + markdown.slice(endIdx + end.length)
}

/** Read back the body of a single zone (without heading / markers).
 * Useful for callers that want to inspect what the page currently
 * shows, e.g. a future "are derivations in sync with the page?"
 * check. Returns null when the zone isn't present. */
export function readZone(
  markdown: string,
  kind: ProfileSectionKey,
): string | null {
  const start = startMarker(kind)
  const end = endMarker(kind)
  const startIdx = markdown.indexOf(start)
  if (startIdx === -1) return null
  const endIdx = markdown.indexOf(end, startIdx + start.length)
  if (endIdx === -1) return null
  const inner = markdown.slice(startIdx + start.length, endIdx).trim()
  // Strip the heading line that the assembler always emits first.
  const heading = PROFILE_SECTIONS[kind].heading
  if (inner.startsWith(heading)) {
    return inner.slice(heading.length).trim()
  }
  return inner
}
