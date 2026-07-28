// Tests for the safety net itself.
//
// A dev-only assertion nobody exercises rots silently: it keeps compiling, stops
// detecting, and the next corruption ships anyway. So the checks are pure functions
// over plain values, and this file feeds them the exact shapes of the four data-loss
// bugs found by hand — plus the healthy shapes they must stay quiet about.
//
// The "quiet" half matters as much as the "loud" half. A check that fires on normal
// operation gets ignored within a day, at which point it is worse than no check. One
// candidate invariant ("red text equals the edit's before text") was dropped for
// exactly that reason: hunks come from a line-level diff, so red legitimately carries
// the trailing newline.

import { describe, expect, it, vi } from 'vitest'
import { EditorState, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  checkMatInvariants,
  cmInBufferReview,
  isSystemTx,
  _setMat,
  type MatViolation,
} from './cmInBufferReview'
import type { ProposalMat } from './proposalPlan'

const mat = (changeId: string, r: [number, number], g: [number, number]): ProposalMat => ({
  changeId,
  hunks: [{ redFrom: r[0], redTo: r[1], greenFrom: g[0], greenTo: g[1], kind: 'replace' }],
})

const kinds = (v: MatViolation[]) => v.map((x) => x.kind)

describe('checkMatInvariants — stays quiet on healthy states', () => {
  it('no proposals', () => {
    expect(checkMatInvariants([], 20)).toEqual([])
  })

  it('one proposal, green immediately after red', () => {
    // The shape planAdditional produces: greenFrom === redTo.
    expect(checkMatInvariants([mat('c1', [0, 5], [5, 10])], 10)).toEqual([])
  })

  it('a pure append — empty red, green at the same point', () => {
    expect(checkMatInvariants([mat('c1', [7, 7], [7, 14])], 14)).toEqual([])
  })

  it('two proposals that merely touch at a boundary', () => {
    // c1 ends exactly where c2 begins. Adjacent is not overlapping.
    expect(checkMatInvariants([mat('c1', [0, 5], [5, 10]), mat('c2', [10, 15], [15, 20])], 20)).toEqual([])
  })

  it('a decided proposal collapsed to a point', () => {
    // Accept/reject collapse one side; zero-width spans are skipped, not flagged.
    expect(checkMatInvariants([mat('c1', [4, 4], [4, 9])], 9)).toEqual([])
  })
})

describe('checkMatInvariants — reports the shapes that actually shipped', () => {
  it('green covering its own red (the undo-an-accept corruption)', () => {
    // Undoing an accept expanded green from the collapse point instead of past the
    // re-inserted red, so green spanned the whole document and the saved body — which
    // is the document minus green — came out empty.
    expect(kinds(checkMatInvariants([mat('c1', [0, 5], [0, 10])], 10))).toContain('red-green')
  })

  it('a second proposal starting inside the first one (the swallowed-suggestion bug)', () => {
    // c2's red began at c1's green because a clean→real boundary resolved to "before
    // the green". Accepting c2 would have deleted c1's suggestion with it.
    const v = checkMatInvariants([mat('c1', [0, 7], [7, 16]), mat('c2', [7, 22], [22, 39])], 39)
    expect(kinds(v)).toContain('cross-mat')
  })

  it('a range past the end of the document', () => {
    expect(kinds(checkMatInvariants([mat('c1', [0, 5], [5, 99])], 10))).toContain('bounds')
  })

  it('an inverted range', () => {
    expect(kinds(checkMatInvariants([mat('c1', [9, 4], [9, 12])], 12))).toContain('bounds')
  })

  it('names the offending proposals so the report is actionable', () => {
    const v = checkMatInvariants([mat('alpha', [0, 7], [7, 16]), mat('beta', [7, 22], [22, 39])], 39)
    expect(v[0].detail).toContain('alpha')
    expect(v[0].detail).toContain('beta')
  })
})

describe('isSystemTx', () => {
  // Only this module's own materialize/refresh transactions qualify: they are kept
  // out of undo history and carry no decision. Those must never move the saved body,
  // which is how the refresh-deletes-red bug would have announced itself.
  const tx = (opts: { history: boolean; decision: boolean }) =>
    ({
      annotation: (t: unknown) => (t === Transaction.addToHistory ? opts.history : undefined),
      effects: opts.decision ? [{ is: () => true }] : [],
    }) as never

  it('is false with no transactions', () => {
    expect(isSystemTx([])).toBe(false)
  })

  it('is false for a user edit (enters history)', () => {
    expect(isSystemTx([tx({ history: true, decision: false })])).toBe(false)
  })

  it('is false for an accept/reject even outside history', () => {
    expect(isSystemTx([tx({ history: false, decision: true })])).toBe(false)
  })

  it('is true for materialize / refresh', () => {
    expect(isSystemTx([tx({ history: false, decision: false })])).toBe(true)
  })

  it('is false when a system tx is batched with a user edit', () => {
    expect(isSystemTx([tx({ history: false, decision: false }), tx({ history: true, decision: false })])).toBe(false)
  })
})

describe('the watchdog is actually wired into the editor', () => {
  // The checks above could be flawless and still never run. This drives a real
  // editor into a state the checks reject and asserts something is reported —
  // without it, deleting the listener would leave every test above green.
  it('reports an overlapping proposal reaching the buffer', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: 'abcdefghij', extensions: [cmInBufferReview('inbox/Note')] }),
    })
    view.dispatch({ effects: _setMat.of([mat('c1', [0, 5], [0, 10])]) })

    const said = spy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(said).toContain('[cm-review] invariant')
    expect(said).toContain('red-green')
    spy.mockRestore()
    view.destroy()
  })
})
