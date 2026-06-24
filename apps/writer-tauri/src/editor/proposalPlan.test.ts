import { describe, it, expect } from 'vitest'
import { planProposals, greenRangesOf, stripRanges } from './proposalPlan'
import type { PendingChange } from '@/state/pendingChangesStore'

// Minimal PendingChange factory for a single 'replace' edit.
function replaceChange(id: string, before: string, after: string): PendingChange {
  return {
    id,
    source: 'chat',
    pageSlug: 'note',
    groupId: 'g',
    createdAt: 0,
    edits: [{ id: `${id}:0`, kind: 'replace', anchorBefore: '', before, after }],
    context: {},
    status: 'pending',
    decidedAt: null,
    viewedAt: null,
  } as PendingChange
}

// Apply clean-doc-coordinate insertions right-to-left (so offsets stay valid).
function applyInsertions(doc: string, insertions: { from: number; insert: string }[]): string {
  let text = doc
  for (const ins of [...insertions].sort((a, b) => b.from - a.from)) {
    text = text.slice(0, ins.from) + ins.insert + text.slice(ins.from)
  }
  return text
}

describe('planProposals', () => {
  it('inserts the proposal as real text after the old line', () => {
    const clean = 'apple is red.\nbanana is yellow.\n'
    const plan = planProposals(clean, [replaceChange('c1', 'apple is red.', 'apple is ripe red.')])
    const doc = applyInsertions(clean, plan.insertions)
    // both old and new present, stacked
    expect(doc).toContain('apple is red.')
    expect(doc).toContain('apple is ripe red.')
  })

  it('ROUND-TRIP: stripping green returns the exact clean doc (what we save)', () => {
    const clean = 'apple is red.\nbanana is yellow.\n'
    const plan = planProposals(clean, [replaceChange('c1', 'apple is red.', 'apple is ripe red.')])
    const doc = applyInsertions(clean, plan.insertions)
    expect(stripRanges(doc, greenRangesOf(plan.mats))).toBe(clean)
  })

  it('green range actually covers the proposal text', () => {
    const clean = 'apple is red.\nbanana is yellow.\n'
    const plan = planProposals(clean, [replaceChange('c1', 'apple is red.', 'apple is ripe red.')])
    const doc = applyInsertions(clean, plan.insertions)
    const g = greenRangesOf(plan.mats)[0]
    expect(doc.slice(g.from, g.to)).toContain('apple is ripe red.')
  })

  it('ROUND-TRIP holds with TWO changes on different lines', () => {
    const clean = 'one\ntwo\nthree\n'
    const plan = planProposals(clean, [
      replaceChange('a', 'one', 'ONE'),
      replaceChange('b', 'three', 'THREE'),
    ])
    const doc = applyInsertions(clean, plan.insertions)
    expect(doc).toContain('ONE')
    expect(doc).toContain('THREE')
    expect(stripRanges(doc, greenRangesOf(plan.mats))).toBe(clean) // both strip cleanly
  })
})
