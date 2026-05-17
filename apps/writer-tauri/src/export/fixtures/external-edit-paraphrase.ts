/**
 * Stage 2 — fixture 4: word-level paraphrase inside a marked span.
 *
 * Models: user reworded the marked sentence ("the company" → "the firm").
 * That's ~7 chars of edits in a ~30-char span — the boundary case where
 * a tighter fuzzy threshold (0.85) rejects but a looser one (0.65/0.75)
 * accepts.
 *
 * This is the most informative fixture for the threshold decision: it
 * tells us what kind of edit users can make before marks lose their
 * anchoring.
 *
 * Default-threshold expectation (0.75): degraded. The threshold sweep
 * reports actual behavior at 0.65 / 0.75 / 0.85 separately.
 */

import type { ExternalEditFixture } from './types.js'

const originalText =
  'Sarah is the engineering lead for the AI team. She joined the company in 2024 and built infrastructure.'
const editedText =
  'Sarah is the engineering lead for the AI team. She joined the firm in 2024 and built infrastructure.'

function rangeOf(text: string, span: string): { from: number; to: number } {
  const from = text.indexOf(span)
  if (from === -1) throw new Error(`fixture broken — span not found: ${JSON.stringify(span)}`)
  return { from, to: from + span.length }
}

const sarahLead = rangeOf(originalText, 'Sarah is the engineering lead')
const joinedCompany = rangeOf(originalText, 'She joined the company in 2024')

export const externalEditParaphrase: ExternalEditFixture = {
  name: 'external-edit-paraphrase',
  description:
    'Paraphrase inside marked span ("the company" → "the firm"). ~7 chars ' +
    'edited in a 30-char quote. Boundary case for threshold sensitivity.',
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
        id: 'mark-joined-paraphrased',
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
      markId: 'mark-joined-paraphrased',
      // At threshold 0.75, fuzzy should accept (similarity ≈ 0.77).
      // The threshold sweep test re-runs at 0.65 / 0.85 separately.
      expectedStatus: 'degraded',
      expectedRangeText: 'She joined the firm in 2024',
    },
  ],
}
