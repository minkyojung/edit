// Shared "effectively empty" predicate for markdown / PM text.
//
// Five callsites used to hand-roll slightly different regex
// variants to answer the same question — "is this just zero-width
// chars or whitespace?" — for things like:
//   - placeholder hint visibility (placeholderPlugin)
//   - empty-doc short-circuit (useIdleTrigger.readDocLength)
//   - empty-body display in wiki catalog (wikiService.readWikiMarkdown)
//   - ditto for ingest's source doc fetch (ingest.readDocMarkdown)
//   - leading ZWS-paragraph cleanup in index merge (applyIngest)
//
// Each had its own definition: `text === '​'`, `/[​\s]/g`,
// `/[​-‍﻿\s]/g`, etc. That meant a body which the server seeded
// with two ZWS or with a BOM passed one check and failed another —
// the placeholder hint disappearing on fresh wiki pages was the
// visible symptom.
//
// One regex, one helper, one definition.
//
// Range covered:
//   U+200B  ZERO WIDTH SPACE
//   U+200C  ZERO WIDTH NON-JOINER
//   U+200D  ZERO WIDTH JOINER
//   U+FEFF  ZERO WIDTH NO-BREAK SPACE (BOM)
//   \s      tabs / spaces / newlines / unicode whitespace
//
// Why this set: proof-server's projection re-encodes our ZWS-only
// seed body as variants on round-trip; pasted text from other
// editors occasionally carries BOMs; collapsing them all into
// "empty" matches user intuition (an invisible-only block reads as
// empty whether the user typed it or not).

const EFFECTIVELY_EMPTY_RE = /[​-‍﻿\s]/g

/** True when `text` is empty after stripping zero-width chars and
 * whitespace. Use this anywhere you'd otherwise write `text === ''`
 * or `text === '​'` — those checks miss the variants the server
 * sometimes produces and lead to inconsistent UI affordances. */
export function isEffectivelyEmpty(text: string): boolean {
  if (text.length === 0) return true
  return text.replace(EFFECTIVELY_EMPTY_RE, '').length === 0
}

/** Length of `text` after stripping zero-width chars and
 * whitespace. Use for "how much real content does this have?"
 * comparisons — e.g. the idle trigger's empty-source short-circuit. */
export function effectiveLength(text: string): number {
  return text.replace(EFFECTIVELY_EMPTY_RE, '').length
}

/** First line in `text` that contains anything beyond whitespace +
 * zero-width chars, trimmed. Returns null when no such line exists.
 *
 * Used by the Tier 1 wiki index builder as a fallback summary when a
 * page's sidecar `aiSummary` hasn't been generated yet. The index
 * builder is the only caller today but the predicate is intentionally
 * generic — any future "give me a one-line preview of this body"
 * surface (search results, sidebar hover) can reuse it. */
export function firstNonEmptyLine(text: string): string | null {
  for (const line of text.split('\n')) {
    if (!isEffectivelyEmpty(line)) return line.trim()
  }
  return null
}
