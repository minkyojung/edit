/**
 * Stage 2 — fixture 3: single-character typo fix inside a marked span.
 *
 * Models: a date typo in the marked sentence. The mark covered the wrong
 * year ("2024"); the user fixes it to "2025" while everything else stays.
 *
 * Exact-match misses (the quote string is no longer present). Fuzzy with
 * Levenshtein should land easily — only 1 char differs out of ~30, so
 * similarity ≈ 0.97, well above all sweep thresholds (0.65 / 0.75 / 0.85).
 *
 * Includes one unaffected mark to make sure fuzzy doesn't drag everything
 * around when it kicks in.
 */

import type { ExternalEditFixture } from './types.js'

const originalText =
  'Sarah is the engineering lead for the AI team. She joined the company in 2024.'
const editedText =
  'Sarah is the engineering lead for the AI team. She joined the company in 2025.'

function rangeOf(text: string, span: string): { from: number; to: number } {
  const from = text.indexOf(span)
  if (from === -1) throw new Error(`fixture broken — span not found: ${JSON.stringify(span)}`)
  return { from, to: from + span.length }
}

const sarahLead = rangeOf(originalText, 'Sarah is the engineering lead')
const joinedCompany = rangeOf(originalText, 'She joined the company in 2024')

export const externalEditTypoFix: ExternalEditFixture = {
  name: 'external-edit-typo-fix',
  description:
    'Typo fix inside the marked span (2024 → 2025). One character changes; ' +
    'exact match fails but fuzzy should comfortably land on the same sentence.',
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
        id: 'mark-joined-typo',
        kind: 'comment',
        attrs: { by: 'human:will', text: 'wrong year' },
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
      markId: 'mark-joined-typo',
      expectedStatus: 'degraded',
      // After the fix, the mark should still cover the same conceptual
      // sentence, now with the corrected year.
      expectedRangeText: 'She joined the company in 2025',
    },
  ],
}
