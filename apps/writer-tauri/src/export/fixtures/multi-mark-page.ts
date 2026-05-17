/**
 * Stage 1 fixture: a longer page with 5 marks of mixed kinds, including
 * one pair that share a quote phrase (forcing the occurrence/context path
 * even in the no-edit case). Stress-tests serializer's anchor extraction.
 */

import type { SerializerInput } from '../serializer.js'

const text = [
  '# Sarah',
  '',
  'Sarah is the engineering lead for the AI team.',
  'She joined the company in 2024.',
  '',
  '## Notes',
  '- Previously worked on infrastructure.',
  '- Reports to the CTO.',
  '- She joined the company in 2024 (overlap with above — same phrase used twice intentionally).',
  '',
].join('\n')

function rangeOf(span: string, fromHint = 0): { from: number; to: number } {
  const from = text.indexOf(span, fromHint)
  if (from === -1) throw new Error(`fixture broken — span not found: ${JSON.stringify(span)}`)
  return { from, to: from + span.length }
}

// First "She joined the company in 2024" — proofAuthored.
const joined1 = rangeOf('She joined the company in 2024')
// Second occurrence — proofComment. Disambiguated by occurrence + context.
const joined2 = rangeOf('She joined the company in 2024', joined1.to)

const aiTeam = rangeOf('engineering lead for the AI team')
const reportsTo = rangeOf('Reports to the CTO')
const prev = rangeOf('Previously worked on infrastructure')

export const multiMarkPage: SerializerInput = {
  text,
  marks: [
    {
      id: 'mark-aiTeam',
      kind: 'authored',
      attrs: { by: 'ai:claude' },
      from: aiTeam.from,
      to: aiTeam.to,
    },
    {
      id: 'mark-joined-1',
      kind: 'authored',
      attrs: { by: 'ai:claude' },
      from: joined1.from,
      to: joined1.to,
    },
    {
      id: 'mark-joined-2',
      kind: 'comment',
      attrs: { by: 'human:will', text: 'Is this the same fact?' },
      from: joined2.from,
      to: joined2.to,
    },
    {
      id: 'mark-prev',
      kind: 'provenance',
      attrs: { by: 'ai:claude', sourceSlug: 'team-history' },
      from: prev.from,
      to: prev.to,
    },
    {
      id: 'mark-cto',
      kind: 'approved',
      attrs: { by: 'human:will' },
      from: reportsTo.from,
      to: reportsTo.to,
    },
  ],
}
