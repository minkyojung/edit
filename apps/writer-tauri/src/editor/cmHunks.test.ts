import { describe, expect, it } from 'vitest'
import { computeCmHunks } from './cmHunks'
import type { PendingChange, PendingEdit } from '@/state/pendingChangesStore'

/** Minimal PendingChange carrying only the fields computeCmHunks reads.
 * `anchorBefore` defaults to '' (append) unless an edit overrides it. */
function change(
  edits: Array<Pick<PendingEdit, 'kind' | 'before' | 'after'> & Partial<Pick<PendingEdit, 'anchorBefore'>>>,
): PendingChange {
  return {
    id: 'c1',
    source: 'chat',
    pageSlug: 'wiki:x',
    groupId: 'g1',
    createdAt: 0,
    edits: edits.map((e, i) => ({ id: `e${i}`, anchorBefore: '', ...e })),
    context: {},
    status: 'pending',
    decidedAt: null,
    viewedAt: null,
    pageMarkdownSnapshot: '',
    feedbackDeliveredAt: null,
  }
}

describe('computeCmHunks', () => {
  it('whole-file Write into an empty doc → one add hunk covering everything', () => {
    const hunks = computeCmHunks('', change([{ kind: 'replace', after: 'hello\nworld\n' }]))
    expect(hunks).toEqual([{ from: 0, to: 0, after: 'hello\nworld\n', kind: 'add' }])
  })

  it('whole-file Write that changes one line → a single replace hunk on that line', () => {
    const doc = 'a\nb\nc\n'
    const hunks = computeCmHunks(doc, change([{ kind: 'replace', after: 'a\nB\nc\n' }]))
    // 'a\n' is 2 chars, so the changed line spans [2,4).
    expect(hunks).toEqual([{ from: 2, to: 4, after: 'B\n', kind: 'replace' }])
  })

  it('inline replace with a `before` anchor → whole-line swap', () => {
    const doc = '나이: 45살\n'
    const hunks = computeCmHunks(doc, change([{ kind: 'replace', before: '나이: 45살', after: '나이: 48살' }]))
    expect(hunks).toEqual([{ from: 0, to: doc.length, after: '나이: 48살\n', kind: 'replace' }])
  })

  it('append (add with empty anchor) → an add hunk at end of doc', () => {
    const doc = 'line1\n'
    const hunks = computeCmHunks(doc, change([{ kind: 'add', after: '취미: 축구' }]))
    expect(hunks).toEqual([{ from: doc.length, to: doc.length, after: '취미: 축구', kind: 'add' }])
  })

  it('clean full-line delete → a delete hunk over that line', () => {
    const doc = 'keep\nremove me\nkeep2\n'
    const hunks = computeCmHunks(doc, change([{ kind: 'delete', before: 'remove me\n' }]))
    expect(hunks).toEqual([{ from: 5, to: 15, after: '', kind: 'delete' }])
  })

  it('anchor miss (before not found) → no hunks (silently dropped, not shown)', () => {
    const hunks = computeCmHunks('a\nb\n', change([{ kind: 'replace', before: 'nonexistent', after: 'x' }]))
    expect(hunks).toEqual([])
  })

  it('no-op change → no hunks', () => {
    const hunks = computeCmHunks('same\n', change([{ kind: 'replace', after: 'same\n' }]))
    expect(hunks).toEqual([])
  })
})
