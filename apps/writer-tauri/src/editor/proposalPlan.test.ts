import { describe, it, expect } from 'vitest'
import { planAdditional, cleanToReal, greenRangesOf, redRangesOf, stripRanges } from './proposalPlan'
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

// A fresh batch materialized into a clean doc = planAdditional with no existing green.
describe('planAdditional — fresh batch into a clean doc', () => {
  it('inserts the proposal as real text after the old line', () => {
    const clean = 'apple is red.\nbanana is yellow.\n'
    const plan = planAdditional(clean, [], [replaceChange('c1', 'apple is red.', 'apple is ripe red.')])
    const doc = applyInsertions(clean, plan.insertions)
    // both old and new present, stacked
    expect(doc).toContain('apple is red.')
    expect(doc).toContain('apple is ripe red.')
  })

  it('ROUND-TRIP: stripping green returns the exact clean doc (what we save)', () => {
    const clean = 'apple is red.\nbanana is yellow.\n'
    const plan = planAdditional(clean, [], [replaceChange('c1', 'apple is red.', 'apple is ripe red.')])
    const doc = applyInsertions(clean, plan.insertions)
    expect(stripRanges(doc, greenRangesOf(plan.mats))).toBe(clean)
  })

  it('green range actually covers the proposal text', () => {
    const clean = 'apple is red.\nbanana is yellow.\n'
    const plan = planAdditional(clean, [], [replaceChange('c1', 'apple is red.', 'apple is ripe red.')])
    const doc = applyInsertions(clean, plan.insertions)
    const g = greenRangesOf(plan.mats)[0]
    expect(doc.slice(g.from, g.to)).toContain('apple is ripe red.')
  })

  it('ROUND-TRIP holds with TWO changes on different lines', () => {
    const clean = 'one\ntwo\nthree\n'
    const plan = planAdditional(clean, [], [
      replaceChange('a', 'one', 'ONE'),
      replaceChange('b', 'three', 'THREE'),
    ])
    const doc = applyInsertions(clean, plan.insertions)
    expect(doc).toContain('ONE')
    expect(doc).toContain('THREE')
    expect(stripRanges(doc, greenRangesOf(plan.mats))).toBe(clean) // both strip cleanly
  })
})

describe('cleanToReal', () => {
  it('is identity with no green', () => {
    expect(cleanToReal(6, [])).toBe(6)
  })
  it('shifts a position past a preceding green run', () => {
    // real "AAAAA[XXX]BBB", green [5,8]; clean "AAAAABBB"
    expect(cleanToReal(5, [{ from: 5, to: 8 }])).toBe(5) // at the green's edge → before it
    expect(cleanToReal(6, [{ from: 5, to: 8 }])).toBe(9) // first 'B' in clean → past the green
  })
})

describe('planAdditional — a fresh proposal alongside an existing one', () => {
  it('places the new proposal correctly in the already-dirty doc', () => {
    const clean = 'AAA\nBBB\nCCC\n'
    // first proposal materialized: AAA → XXX
    const plan1 = planAdditional(clean, [], [replaceChange('a', 'AAA', 'XXX')])
    const realDoc = applyInsertions(clean, plan1.insertions) // now has green "XXX"
    const greens1 = greenRangesOf(plan1.mats)

    // add a SECOND proposal (CCC → ZZZ) while the first is still shown
    const plan2 = planAdditional(realDoc, greens1, [replaceChange('b', 'CCC', 'ZZZ')])
    const realDoc2 = applyInsertions(realDoc, plan2.insertions)

    // both proposals are present and intact
    expect(realDoc2).toContain('XXX')
    expect(realDoc2).toContain('ZZZ')
    // the new green/red ranges point at the right text in the FINAL doc
    const g = greenRangesOf(plan2.mats)[0]
    expect(realDoc2.slice(g.from, g.to)).toContain('ZZZ')
    const r = redRangesOf(plan2.mats)[0]
    expect(realDoc2.slice(r.from, r.to)).toContain('CCC')
  })
})
