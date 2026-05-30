// Tolerant text matching for LLM-proposed edits.
//
// Path A reinstates the operational `propose_edit(old_string →
// new_string)` flow. The reason it was abandoned earlier — the
// "couldn't find old_string" failure — happens when the model's
// `old_string` drifts from the stored markdown by a leading list
// marker, colon spacing, or trailing whitespace. This module is the
// safety net: a tiered match that falls back from exact to
// normalized-line comparison, so those benign drifts still resolve
// instead of failing the edit.
//
// Scope deliberately bounded for reliability:
//   - Tier 1 (exact) handles any-length verbatim matches, including
//     sub-line phrases and multi-line blocks.
//   - Tier 2 (normalized) only kicks in for a SINGLE-line needle —
//     the dominant drift case (one value tweak on one bullet). It is
//     never applied to multi-line needles, because stripping a leading
//     marker off line 1 while replacing through to line N would wipe
//     the inner lines' own markers. Multi-line edits that aren't
//     verbatim return null and the caller surfaces them as unplaced
//     rather than risk a wrong splice.

import { canonicalizeLine, leadingMarkerLength } from './lineCanonical'

interface LineSpan {
  text: string
  start: number
  end: number
}

/** Split `body` into lines carrying their char offsets in the original
 * string (so a match maps back to exact positions for replacement). */
function lineSpans(body: string): LineSpan[] {
  const parts = body.split('\n')
  const out: LineSpan[] = []
  let offset = 0
  for (const text of parts) {
    out.push({ text, start: offset, end: offset + text.length })
    offset += text.length + 1 // + the '\n' we split on
  }
  return out
}

/** Drop trailing blank lines from a needle's line array — a model's
 * `old_string` often carries a trailing newline that isn't part of the
 * content to match. */
function needleLines(needle: string): string[] {
  const lines = needle.split('\n')
  while (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines
}

/** Find `needle` in `body`, tolerating benign drift. Returns the char
 * range `[start, end)` in `body` to act on, or null when no acceptable
 * match exists.
 *
 * For a single-line tier-2 match the range covers only the line's
 * CONTENT (after any leading marker) so a replace preserves the
 * marker. For tier-1 it covers the verbatim span as found. */
export function looseFindRange(
  body: string,
  needle: string,
): { start: number; end: number } | null {
  if (needle.length === 0) return null

  // Tier 1 — exact substring (any length).
  const idx = body.indexOf(needle)
  if (idx >= 0) return { start: idx, end: idx + needle.length }

  // Tier 2 — normalized, single-line only.
  const nLines = needleLines(needle)
  if (nLines.length !== 1) return null
  const target = canonicalizeLine(nLines[0])
  if (target.length === 0) return null

  for (const span of lineSpans(body)) {
    if (canonicalizeLine(span.text) !== target) continue
    const markerLen = leadingMarkerLength(span.text)
    return { start: span.start + markerLen, end: span.end }
  }
  return null
}

/** Replace the (tolerant) match of `oldStr` in `body` with `newStr`,
 * or return null when `oldStr` can't be located. */
export function looseReplace(
  body: string,
  oldStr: string,
  newStr: string,
): string | null {
  const range = looseFindRange(body, oldStr)
  if (!range) return null
  return body.slice(0, range.start) + newStr + body.slice(range.end)
}
