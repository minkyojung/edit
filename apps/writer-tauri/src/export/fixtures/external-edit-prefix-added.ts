/**
 * Stage 2 — fixture 2: prefix added immediately before a marked span.
 *
 * Models: user typed a clarifier ("Currently, ") in front of a sentence
 * that has a mark. The mark's `quote` substring is still present verbatim.
 * `contextBefore` no longer matches (we've put new text right against the
 * boundary), but exact-match resolves before context disambiguation runs,
 * so confident is still expected.
 *
 * Also includes an unaffected mark elsewhere to catch regressions where
 * fuzzy matching wanders into wrong spans.
 */

import type { ExternalEditFixture } from './types.js'

const originalText =
  'Sarah is the engineering lead for the AI team. She joined the company in 2024.'
const editedText =
  'Currently, Sarah is the engineering lead for the AI team. She joined the company in 2024.'

function rangeOf(text: string, span: string): { from: number; to: number } {
  const from = text.indexOf(span)
  if (from === -1) throw new Error(`fixture broken — span not found: ${JSON.stringify(span)}`)
  return { from, to: from + span.length }
}

const sarahLead = rangeOf(originalText, 'Sarah is the engineering lead')
const joinedCompany = rangeOf(originalText, 'She joined the company in 2024')

export const externalEditPrefixAdded: ExternalEditFixture = {
  name: 'external-edit-prefix-added',
  description:
    'User typed "Currently, " at the start of the first sentence. The marked ' +
    'quote substring is unchanged; only its left context window is different.',
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
        attrs: { by: 'human:will' },
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
