/**
 * Stage 1 fixture: a single paragraph with two non-overlapping marks.
 *
 * Mirrors the simplest real case — a wiki page with one AI-authored sentence
 * and one pending suggestion on a different span. Verifies the baseline:
 * serialize → deserialize with no text edits should produce confident matches
 * for every mark.
 *
 * Mark offsets are computed from substring lookups so the fixture stays
 * readable and counting mistakes can't sneak in. If a substring is missing
 * the fixture throws at module-load — better to fail loud than silently
 * point at the wrong text.
 */

import type { SerializerInput } from '../serializer.js'

const text =
  'Sarah is the engineering lead for the AI team. ' +
  'She joined the company in 2024 and previously worked on infrastructure.'

const authoredSpan = 'Sarah is the engineering lead for the AI team.'
const suggestionSpan = 'joined the company in 2024'

function rangeOf(span: string): { from: number; to: number } {
  const from = text.indexOf(span)
  if (from === -1) throw new Error(`fixture broken — span not found: ${JSON.stringify(span)}`)
  return { from, to: from + span.length }
}

const authored = rangeOf(authoredSpan)
const suggestion = rangeOf(suggestionSpan)

export const basicParagraph: SerializerInput = {
  text,
  marks: [
    {
      id: 'mark-authored-1',
      kind: 'authored',
      attrs: { by: 'ai:claude', model: 'claude-opus-4-7' },
      from: authored.from,
      to: authored.to,
    },
    {
      id: 'mark-suggestion-1',
      kind: 'replace',
      attrs: { by: 'ai:claude', status: 'pending' },
      from: suggestion.from,
      to: suggestion.to,
    },
  ],
}
