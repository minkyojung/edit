import { describe, expect, it } from 'vitest'
import { computePendingDiffLines } from './pendingDiff'
import type { PendingChange, PendingEdit } from '@/state/pendingChangesStore'

/** Minimal PendingChange for the diff helper — only the fields it reads. */
function change(
  edits: Array<Pick<PendingEdit, 'kind' | 'before' | 'after'>>,
  snapshot = '',
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
    pageMarkdownSnapshot: snapshot,
  }
}

describe('computePendingDiffLines', () => {
  it('shows only the added line for an "append after anchor" replace (no phantom removal)', () => {
    const out = computePendingDiffLines(
      change([{ kind: 'replace', before: '곧 미국으로 이민 예정', after: '곧 미국으로 이민 예정\n취미: 축구' }]),
    )
    expect(out).toEqual([{ kind: 'add', text: '취미: 축구', lineNum: 0 }])
  })

  it('shows a whole-line swap for an inline replace', () => {
    const out = computePendingDiffLines(
      change([{ kind: 'replace', before: '나이: 45살', after: '나이: 48살' }]),
    )
    expect(out).toEqual([
      { kind: 'remove', text: '나이: 45살', lineNum: 0 },
      { kind: 'add', text: '나이: 48살', lineNum: 0 },
    ])
  })

  it('marks every line of a pure add', () => {
    const out = computePendingDiffLines(change([{ kind: 'add', after: '취미: 축구' }]))
    expect(out).toEqual([{ kind: 'add', text: '취미: 축구', lineNum: 0 }])
  })

  it('marks every line of a pure delete', () => {
    const out = computePendingDiffLines(change([{ kind: 'delete', before: '성별: 남자' }]))
    expect(out).toEqual([{ kind: 'remove', text: '성별: 남자', lineNum: 0 }])
  })

  it('diffs a whole-file replace against the snapshot, keeping context', () => {
    const out = computePendingDiffLines(
      change([{ kind: 'replace', after: 'a\nc' }], 'a\nb'),
    )
    expect(out).toEqual([
      { kind: 'context', text: 'a', lineNum: 0 },
      { kind: 'remove', text: 'b', lineNum: 0 },
      { kind: 'add', text: 'c', lineNum: 0 },
    ])
  })

  it('shows 3 lines of document context around an inline replace', () => {
    const snapshot = 'l1\nl2\nl3\nl4\nOLD\nl6\nl7\nl8\nl9'
    const out = computePendingDiffLines(
      change([{ kind: 'replace', before: 'OLD', after: 'NEW' }], snapshot),
    )
    expect(out).toEqual([
      { kind: 'context', text: 'l2', lineNum: 0 },
      { kind: 'context', text: 'l3', lineNum: 0 },
      { kind: 'context', text: 'l4', lineNum: 0 },
      { kind: 'remove', text: 'OLD', lineNum: 0 },
      { kind: 'add', text: 'NEW', lineNum: 0 },
      { kind: 'context', text: 'l6', lineNum: 0 },
      { kind: 'context', text: 'l7', lineNum: 0 },
      { kind: 'context', text: 'l8', lineNum: 0 },
    ])
  })

  it('returns nothing for a no-op edit', () => {
    expect(computePendingDiffLines(change([{ kind: 'replace', before: 'x', after: 'x' }]))).toEqual([])
  })
})
