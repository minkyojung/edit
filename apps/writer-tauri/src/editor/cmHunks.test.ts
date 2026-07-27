import { describe, expect, it } from 'vitest'
import { computeCmHunks, placeEdits, applyEditsToText } from './cmHunks'
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

// The two cases just above BOTH produce `[]`, and that is the whole problem:
// "I couldn't find the text you named" and "there is nothing to do" are opposite
// situations that the hunk list cannot tell apart. Reported to the model as the
// same thing, one of them always sends it somewhere useless — either retrying an
// edit that is already made, or falling silent about one that never landed.
describe('placeEdits — why a change did or did not land', () => {
  it('names each failure differently for the three inputs that all yield no hunks', () => {
    const cases = [
      { doc: 'alpha\nbeta\n', c: change([{ kind: 'replace' as const, before: 'nonexistent', after: 'x' }]),
        expected: { kind: 'absent', editIndex: 0, target: 'nonexistent' } },
      { doc: 'same\n', c: change([{ kind: 'replace' as const, after: 'same\n' }]),
        expected: { kind: 'noop' } },
      { doc: 'dup\ndup\n', c: change([{ kind: 'replace' as const, before: 'dup', after: 'x' }]),
        expected: { kind: 'ambiguous', editIndex: 0, target: 'dup' } },
    ]
    for (const { doc, c, expected } of cases) {
      expect(placeEdits(doc, c).placement).toEqual(expected)
      // …and every one of them still produces no hunks, which is why the verdict
      // has to carry the distinction rather than the caller inferring it from an
      // empty list. Same doc, same change — not a stand-in that trivially yields [].
      expect(computeCmHunks(doc, c)).toEqual([])
    }
  })

  it('a placeable edit is ok, and the text matches what applyEditsToText returns', () => {
    const doc = 'alpha\nbeta\n'
    const c = change([{ kind: 'replace', before: 'beta', after: 'BETA' }])
    const { text, placement } = placeEdits(doc, c)
    expect(placement).toEqual({ kind: 'ok' })
    expect(text).toBe('alpha\nBETA\n')
    expect(text).toBe(applyEditsToText(doc, c))
  })

  it('an edit already made reads as ok, not absent', () => {
    // The model proposes 안녕하세요 → 반갑습니다 against a doc where that swap has
    // already happened. The anchor is genuinely gone, but reporting `absent` here
    // would have the model "fix" something already correct, forever.
    const { placement } = placeEdits(
      '# Greeting\n\n반갑습니다\n',
      change([{ kind: 'replace', before: '안녕하세요', after: '반갑습니다' }]),
    )
    expect(placement).toEqual({ kind: 'noop' })
  })

  it('reports WHICH edit failed, so a MultiEdit can name it', () => {
    const doc = 'alpha\nbeta\n'
    const { placement } = placeEdits(
      doc,
      change([
        { kind: 'replace', before: 'alpha', after: 'ALPHA' },
        { kind: 'replace', before: 'missing', after: 'x' },
      ]),
    )
    expect(placement).toEqual({ kind: 'absent', editIndex: 1, target: 'missing' })
  })

  it('still applies the other edits when one cannot be placed', () => {
    // Skipping-not-abandoning is the pre-existing behaviour of applyEditsToText;
    // adding the verdict must not change what the user sees staged.
    const doc = 'alpha\nbeta\n'
    const c = change([
      { kind: 'replace', before: 'missing', after: 'x' },
      { kind: 'replace', before: 'beta', after: 'BETA' },
    ])
    const { text, placement } = placeEdits(doc, c)
    expect(text).toBe('alpha\nBETA\n')
    expect(text).toBe(applyEditsToText(doc, c))
    expect(placement.kind).toBe('absent')
  })

  it('a failure outranks noop', () => {
    // One edit is already made (noop on its own), the other names text that
    // isn't there. Answering "nothing to do" would bury the real miss.
    const { placement } = placeEdits(
      '반갑습니다\n',
      change([
        { kind: 'replace', before: '안녕하세요', after: '반갑습니다' },
        { kind: 'replace', before: 'missing', after: 'x' },
      ]),
    )
    expect(placement).toEqual({ kind: 'absent', editIndex: 1, target: 'missing' })
  })

  it('a whole-file Write always places (nothing to locate)', () => {
    const { placement } = placeEdits('old\n', change([{ kind: 'replace', after: 'new\n' }]))
    expect(placement).toEqual({ kind: 'ok' })
  })

  it('an append with an unfindable anchor is absent', () => {
    const { placement } = placeEdits(
      'alpha\n',
      change([{ kind: 'add', anchorBefore: 'nowhere', after: 'x' }]),
    )
    expect(placement).toEqual({ kind: 'absent', editIndex: 0, target: 'nowhere' })
  })
})
