// Regression proof for audit A3: reopenEffect (the undo of a decision) had no inverse,
// so REDO of an accept/reject dropped the mat from the buffer but never re-emitted the
// decision — the store's acceptUndoWatcher only reacts to accept/reject/reopen effects,
// so it stayed 'pending' while the buffer showed the accepted text (a ghost pending
// card). The fix makes reopen carry the decision kind and re-emit it on redo, so a redo
// transaction carries the decision again (drives store.accept + shouldRemirror). We
// assert that redo tx via isDecisionTx.

import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, undo, redo } from '@codemirror/commands'
import {
  _matField,
  _setMat,
  _dropChange,
  _acceptEffect,
  _rejectEffect,
  _reviewUndoLink,
  isDecisionTx,
} from './cmInBufferReview'

const mat = {
  changeId: 'c1',
  hunks: [{ redFrom: 0, redTo: 3, greenFrom: 4, greenTo: 7, kind: 'replace' as const }],
}

function viewCapturing(doc: string, sink: boolean[]) {
  return new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      extensions: [
        _matField,
        _reviewUndoLink,
        history(),
        EditorView.updateListener.of((u) => {
          if (u.transactions.length) sink.push(isDecisionTx(u.transactions))
        }),
      ],
    }),
  })
}

describe('in-buffer review — redo re-emits the decision (no ghost pending card)', () => {
  it('accept → undo → redo: the redo transaction carries the decision again', () => {
    const decided: boolean[] = []
    const v = viewCapturing('AAA\nNEW', decided)
    v.dispatch({ effects: _setMat.of([mat]) })
    v.dispatch({ changes: { from: 0, to: 3 }, effects: [_dropChange.of('c1'), _acceptEffect.of('c1')] })
    undo(v) // reopen → store goes pending
    decided.length = 0
    redo(v)
    // Before the fix, the redo tx carried only dropChange → isDecisionTx false → the
    // store never re-accepted. Now it must carry the decision.
    expect(decided.some(Boolean)).toBe(true)
    // …and the buffer is back in the accepted state, in step with the store.
    expect(v.state.field(_matField)).toHaveLength(0)
    expect(v.state.doc.toString()).toBe('\nNEW')
    v.destroy()
  })

  it('reject → undo → redo: same symmetry for the reject decision', () => {
    const decided: boolean[] = []
    const v = viewCapturing('AAA\nNEW', decided)
    v.dispatch({ effects: _setMat.of([mat]) })
    v.dispatch({ changes: { from: 4, to: 7 }, effects: [_dropChange.of('c1'), _rejectEffect.of('c1')] })
    undo(v)
    decided.length = 0
    redo(v)
    expect(decided.some(Boolean)).toBe(true)
    expect(v.state.field(_matField)).toHaveLength(0)
    expect(v.state.doc.toString()).toBe('AAA\n')
    v.destroy()
  })
})
