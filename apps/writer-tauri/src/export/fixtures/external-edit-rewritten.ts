/**
 * Stage 2 — fixture 5: marked span entirely rewritten.
 *
 * Models: user rewrote the marked sentence from scratch. Almost no character
 * overlap with the original. This is the "should be orphaned" case — fuzzy
 * must NOT drag the mark onto unrelated nearby text, because doing so would
 * surface a stale attribution on text the user never authored that way.
 *
 * The unaffected mark must remain confident regardless.
 */

import type { ExternalEditFixture } from './types.js'

const originalText =
  'Sarah is the engineering lead for the AI team. She joined the company in 2024.'
const editedText =
  'Sarah is the engineering lead for the AI team. Hired during the Q3 expansion.'

function rangeOf(text: string, span: string): { from: number; to: number } {
  const from = text.indexOf(span)
  if (from === -1) throw new Error(`fixture broken — span not found: ${JSON.stringify(span)}`)
  return { from, to: from + span.length }
}

const sarahLead = rangeOf(originalText, 'Sarah is the engineering lead')
const joinedCompany = rangeOf(originalText, 'She joined the company in 2024')

export const externalEditRewritten: ExternalEditFixture = {
  name: 'external-edit-rewritten',
  description:
    'Marked sentence replaced wholesale ("She joined the company in 2024" → ' +
    '"Hired during the Q3 expansion"). Mark should be orphaned; the AI ' +
    'attribution does NOT belong on text the user freshly wrote.',
  original: {
    text: originalText,
    marks: [
      {
        id: 'mark-lead-unaffected',
        kind: 'authored',
        attrs: { by: 'ai:claude' },
        from: sarahLead.from,
        to: sarahLead.to,
      },
      {
        id: 'mark-joined-rewritten',
        kind: 'authored',
        attrs: { by: 'ai:claude' },
        from: joinedCompany.from,
        to: joinedCompany.to,
      },
    ],
  },
  edited: editedText,
  expectations: [
    {
      markId: 'mark-lead-unaffected',
      expectedStatus: 'confident',
      expectedRangeText: 'Sarah is the engineering lead',
    },
    {
      markId: 'mark-joined-rewritten',
      expectedStatus: 'orphaned',
    },
  ],
}
