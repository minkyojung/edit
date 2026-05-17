/**
 * Stage 2 — fixture 1: unrelated line inserted between two marked spans.
 *
 * Models the most common real edit: user adds a sentence somewhere in the
 * doc that has nothing to do with any AI-attached span. Every mark's
 * `quote` is still present verbatim; only their character offsets shift.
 *
 * Both marks should resolve as `confident` since exact quote matching wins
 * before fuzzy ever gets invoked.
 */

import type { ExternalEditFixture } from './types.js'

const originalText =
  'Sarah is the engineering lead for the AI team. She joined the company in 2024.'
const editedText =
  'Sarah is the engineering lead for the AI team. The team recently doubled in size. She joined the company in 2024.'

function rangeOf(text: string, span: string): { from: number; to: number } {
  const from = text.indexOf(span)
  if (from === -1) throw new Error(`fixture broken — span not found: ${JSON.stringify(span)}`)
  return { from, to: from + span.length }
}

const sarahLead = rangeOf(originalText, 'Sarah is the engineering lead')
const joinedCompany = rangeOf(originalText, 'She joined the company in 2024')

export const externalEditUnrelatedLine: ExternalEditFixture = {
  name: 'external-edit-unrelated-line',
  description:
    'Inserts an unrelated sentence between the two marked spans. Both quotes ' +
    'remain intact; only offsets shift.',
  original: {
    text: originalText,
    marks: [
      {
        id: 'mark-lead',
        kind: 'authored',
        attrs: { by: 'ai:claude' },
        from: sarahLead.from,
        to: sarahLead.to,
      },
      {
        id: 'mark-joined',
        kind: 'comment',
        attrs: { by: 'human:will', text: 'when did she join?' },
        from: joinedCompany.from,
        to: joinedCompany.to,
      },
    ],
  },
  edited: editedText,
  expectations: [
    {
      markId: 'mark-lead',
      expectedStatus: 'confident',
      expectedRangeText: 'Sarah is the engineering lead',
    },
    {
      markId: 'mark-joined',
      expectedStatus: 'confident',
      expectedRangeText: 'She joined the company in 2024',
    },
  ],
}
