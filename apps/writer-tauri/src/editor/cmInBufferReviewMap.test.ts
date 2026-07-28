// Regression proof for audit A2: the addMat StateEffect carries document positions, so
// it must define `map`. Sequence that bit: accept a change (its inverse [reopen, addMat]
// lands in undo history) → a NON-historized doc change arrives (the reconciler's
// INSERT/REFRESH when a new proposal merges is dispatched addToHistory:false) → CM
// remaps the stored history event, mapping its CHANGES; without a matching effect map,
// the addMat payload keeps stale offsets. On undo, the red text is restored at the right
// place but matField points at the OLD coordinates → savedBodyOf strips the wrong "green"
// range into the saved body (disk corruption). We drive the real history + invertedEffects
// wiring headlessly and assert the mapped hunk still points at the actual red/green text.

import { describe, it, expect } from 'vitest'
import { EditorState, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, undo } from '@codemirror/commands'
import {
  _matField,
  _setMat,
  _dropChange,
  _acceptEffect,
  _reviewUndoLink,
  savedBodyOf,
} from './cmInBufferReview'

// 'HEAD\nAAA\nNEW\nTAIL' — red "AAA" at [5,8], green "NEW" at [9,12], with HEAD/TAIL
// padding so the intervening edit can land FAR from the change (as the reconciler's
// append does), not on top of its coordinates.
const mat = {
  changeId: 'c1',
  hunks: [{ redFrom: 5, redTo: 8, greenFrom: 9, greenTo: 12, kind: 'replace' as const }],
}

function view(doc: string) {
  return new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, extensions: [_matField, _reviewUndoLink, history()] }),
  })
}

describe('in-buffer review — addMat maps positions across a non-historized change', () => {
  it('undo after an intervening addToHistory:false edit restores the hunk at the CORRECT offsets', () => {
    const v = view('HEAD\nAAA\nNEW\nTAIL')
    v.dispatch({ effects: _setMat.of([mat]) })

    // Keep (accept): delete the red; drop + acceptEffect. History stores the inverse
    // [reopen('c1'), addMat(mat)] in post-decision coordinates.
    v.dispatch({ changes: { from: 5, to: 8 }, effects: [_dropChange.of('c1'), _acceptEffect.of('c1')] })
    expect(v.state.doc.toString()).toBe('HEAD\n\nNEW\nTAIL')
    expect(v.state.field(_matField)).toHaveLength(0)

    // A non-historized doc change (the reconciler merging a new proposal) appends below,
    // shifting positions after it. CM remaps the stored undo event — and, with the fix,
    // the addMat payload with it.
    v.dispatch({ changes: { from: 14, insert: 'ZZ' }, annotations: Transaction.addToHistory.of(false) })
    expect(v.state.doc.toString()).toBe('HEAD\n\nNEW\nTAILZZ')

    // Undo the keep: the red text returns and matField is restored from the (remapped)
    // addMat effect.
    undo(v)
    const doc = v.state.doc.toString()
    const hunk = v.state.field(_matField)[0].hunks[0]

    // The restored hunk must point at the ACTUAL red/green text — the whole bug is that
    // without the effect map these slices land on the wrong characters.
    expect(doc.slice(hunk.redFrom, hunk.redTo)).toBe('AAA')
    expect(doc.slice(hunk.greenFrom, hunk.greenTo)).toBe('NEW')

    // …so the saved body strips the real green (disk = accepted-so-far = red kept),
    // never a mis-located slice.
    const saved = savedBodyOf(v.state)
    expect(saved).not.toContain('NEW')
    expect(saved).toContain('AAA')
    expect(saved).toContain('ZZ')
    v.destroy()
  })
})
