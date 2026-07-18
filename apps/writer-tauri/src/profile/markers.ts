// Zone scheme for the wiki:profile page.
//
// Earlier this file used HTML-comment markers (<!-- derived:voice
// start --> … <!-- /derived:voice end -->) to delimit zones. That
// didn't survive the Milkdown markdown roundtrip: HTML comments
// aren't a node in the editor schema, so the parser dropped them
// the moment the page was loaded and re-serialised. The on-disk
// markdown ended up clean but unparseable by us.
//
// New scheme: zones are demarcated by their H2 headings. The
// heading text itself is the zone identifier, and the next H2
// heading marks the zone boundary. This survives roundtrip (H2 is
// a first-class node), stays readable to humans, and matches how
// the rest of the wiki already treats sections.
//
// The page layout, top to bottom:
//
//   ## Voice         ← derivation zone (Voice analysis)
//   ## Themes        ← derivation zone
//   ## About         ← derivation zone
//   ## Sources       ← link list, regenerated each run
//   ## Background    ← ingest-managed, append-only
//   ## Notes         ← user-owned, never touched by code
//
// Code that wants to splice a single zone uses {@link replaceZone};
// code that needs the whole markdown assembled from scratch uses
// {@link assembleProfileMarkdown}.

import type { ProfileSectionKey } from './conventions'
import { PROFILE_SECTIONS } from './conventions'

const SECTION_ORDER: ProfileSectionKey[] = ['voice', 'themes', 'about']

/** Section name a zone is identified by — the literal H2 text the
 * page assembler emits. */
export function zoneHeading(kind: ProfileSectionKey): string {
  return PROFILE_SECTIONS[kind].heading
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
 * derivations plus a Sources list. Empty Background and Notes
 * headings appear at the bottom so they're present from day one
 * (ingest needs a stable Background target; the user gets a Notes
 * area without having to create it). */
export function assembleProfileMarkdown(
  derivations: DerivationInput[],
  sources: SourceLink[],
): string {
  const byKind = new Map(derivations.map((d) => [d.kind, d.content]))
  const blocks: string[] = []

  for (const kind of SECTION_ORDER) {
    const content = byKind.get(kind)
    if (!content) continue
    blocks.push(`${zoneHeading(kind)}\n\n${content.trim()}`)
  }

  if (sources.length > 0) {
    blocks.push(
      ['## Sources', sources.map((s) => `- [${s.title}](${s.sourceUrl})`).join('\n')].join('\n\n'),
    )
  }

  // Day-one stubs for ingest's append target + the user's free area.
  blocks.push('## Background')
  blocks.push('## Notes')

  return blocks.join('\n\n') + '\n'
}

/** Replace the body of a single derivation zone in an existing
 * profile markdown. Finds the heading line, then writes the new
 * content up to (but not including) the next H2 heading. Other
 * zones, the Sources list, Background, and Notes are preserved
 * verbatim — including any user edits.
 *
 * Returns null when the heading isn't found in the input. Caller
 * should treat that as "fall back to a full rebuild" — silently
 * dropping the write would lose work. */
export function replaceZone(
  markdown: string,
  kind: ProfileSectionKey,
  newContent: string,
): string | null {
  const heading = zoneHeading(kind)
  const start = findHeadingLine(markdown, heading)
  if (start === null) return null

  // End of this zone = next H2 OR end of file.
  const afterHeading = start + heading.length + 1 // +1 for trailing newline
  const nextHeadingAt = findNextH2(markdown, afterHeading)
  const end = nextHeadingAt === null ? markdown.length : nextHeadingAt

  const before = markdown.slice(0, start)
  const after = markdown.slice(end)
  // Trailing blank line so the next section's heading sits cleanly
  // below this zone. Trim any whitespace the caller left attached to
  // the new content so we don't accumulate blank lines on re-run.
  const zone = `${heading}\n\n${newContent.trim()}\n\n`
  return before + zone + after
}

/** The ingest append target on the profile page. Not a derivation zone
 * (those are voice/themes/about, keyed by ProfileSectionKey), so it's a
 * plain literal heading rather than a PROFILE_SECTIONS entry. */
const BACKGROUND_HEADING = '## Background'

/** Append `block` into the `## Background` zone of a profile markdown,
 * preserving every other zone verbatim — including the user-owned
 * `## Notes`. This is the correct landing spot for ingest / chat facts
 * about the user; the prior behaviour appended to the raw end of the
 * file, which dropped content AFTER `## Notes`.
 *
 * When the profile has no `## Background` heading yet (a fresh page that
 * never ran the derivation pipeline), the heading is created at the end
 * so the content still lands in a labelled zone rather than loose at EOF.
 * Returns the new full markdown. */
export function appendToBackground(markdown: string, block: string): string {
  const trimmed = block.trim()
  if (!trimmed) return markdown

  const start = findHeadingLine(markdown, BACKGROUND_HEADING)
  if (start === null) {
    const head = markdown.trimEnd()
    const sep = head.length > 0 ? '\n\n' : ''
    return `${head}${sep}${BACKGROUND_HEADING}\n\n${trimmed}\n`
  }

  const afterHeading = start + BACKGROUND_HEADING.length + 1 // +1 trailing newline
  const nextHeadingAt = findNextH2(markdown, afterHeading)
  const end = nextHeadingAt === null ? markdown.length : nextHeadingAt
  const existing = markdown.slice(afterHeading, end).trim()
  const before = markdown.slice(0, start)
  const after = markdown.slice(end)
  const body = existing ? `${existing}\n\n${trimmed}` : trimmed
  return `${before}${BACKGROUND_HEADING}\n\n${body}\n\n${after}`
}

/** Split the profile into the small SUMMARY zones (Voice / Themes / About /
 * Sources / Notes) and the append-only `## Background` zone. Used to keep the
 * bounded summary always-on in the system prompt while the unbounded, growing
 * Background is loaded on demand (the model Reads the profile file when it
 * needs a specific personal fact).
 *
 * `summary` is the full markdown with the Background heading + its body
 * removed, every other zone preserved verbatim (order intact). `background` is
 * the Background body, trimmed ('' when the zone is absent or empty). When
 * there's no Background, `summary` is the input unchanged and `background` is
 * ''. */
export function splitOutBackground(markdown: string): {
  summary: string
  background: string
} {
  const start = findHeadingLine(markdown, BACKGROUND_HEADING)
  if (start === null) return { summary: markdown.trim(), background: '' }

  const afterHeading = start + BACKGROUND_HEADING.length + 1
  const nextHeadingAt = findNextH2(markdown, afterHeading)
  const end = nextHeadingAt === null ? markdown.length : nextHeadingAt
  const background = markdown.slice(afterHeading, end).trim()

  const before = markdown.slice(0, start).trimEnd()
  const after = markdown.slice(end).trim() // e.g. the `## Notes` zone
  const summary = after ? `${before}\n\n${after}` : before
  return { summary: summary.trim(), background }
}

/** Read back the body of a single zone, without the heading line.
 * Returns null when the heading isn't found. */
export function readZone(
  markdown: string,
  kind: ProfileSectionKey,
): string | null {
  const heading = zoneHeading(kind)
  const start = findHeadingLine(markdown, heading)
  if (start === null) return null

  const afterHeading = start + heading.length + 1
  const nextHeadingAt = findNextH2(markdown, afterHeading)
  const end = nextHeadingAt === null ? markdown.length : nextHeadingAt
  return markdown.slice(afterHeading, end).trim()
}

/** Locate a heading line in the markdown. Matches the heading text
 * only when it starts at column 0 — avoids false hits on `## Voice`
 * mentioned inside a paragraph or code block (rare, but not zero). */
function findHeadingLine(markdown: string, heading: string): number | null {
  // Two anchors: start-of-file or after a newline. The heading must
  // be followed by either a newline or end-of-file.
  if (markdown.startsWith(`${heading}\n`) || markdown === heading) {
    return 0
  }
  const needle = `\n${heading}\n`
  const idx = markdown.indexOf(needle)
  if (idx === -1) {
    // Also try heading-at-EOF, no trailing newline.
    const tailNeedle = `\n${heading}`
    if (markdown.endsWith(tailNeedle)) {
      return markdown.length - heading.length
    }
    return null
  }
  return idx + 1 // skip the leading newline
}

/** Find the byte offset of the next H2 heading at or after `from`.
 * Matches "## " at column 0; ignores H1, H3+, and inline `##`. */
function findNextH2(markdown: string, from: number): number | null {
  // Look for "\n## " (a newline followed by H2 start) — column-0 hits
  // captured by including the preceding newline in the pattern.
  const needle = '\n## '
  const idx = markdown.indexOf(needle, from)
  if (idx === -1) return null
  return idx + 1 // position of the '#' so the caller can slice up to here
}
