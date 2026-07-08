// The reported bug: Reject (or Accept) then Cmd-Z duplicated the proposal. Root
// cause was matField NOT being restored on undo, so the reconciler re-inserted.
// This pins the fix: an undo of a reject restores the change's ranges in matField
// (in lockstep with the restored text), so it's seen as still-materialized.
import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, undo, redo } from '@codemirror/commands'
import { _matField, _setMat, _dropChange, _rejectEffect, _acceptEffect, _reviewUndoLink } from './cmInBufferReview'

function view(doc: string) {
  return new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, extensions: [_matField, _reviewUndoLink, history()] }),
  })
}

// A change whose red is "AAA" [0,3] and green is "NEW" inserted at [4,7].
const mat = {
  changeId: 'c1',
  hunks: [{ redFrom: 0, redTo: 3, greenFrom: 4, greenTo: 7, kind: 'replace' as const }],
}

describe('in-buffer review — undo restores matField (no duplicate)', () => {
  it('reject → undo brings the change back into matField', () => {
    const v = view('AAA\nNEW') // red "AAA", green "NEW"
    v.dispatch({ effects: _setMat.of([mat]) })
    expect(v.state.field(_matField)).toHaveLength(1)

    // Reject: delete the green + drop the change (undoable).
    v.dispatch({ changes: { from: 4, to: 7 }, effects: [_dropChange.of('c1'), _rejectEffect.of('c1')] })
    expect(v.state.field(_matField)).toHaveLength(0) // dropped
    expect(v.state.doc.toString()).toBe('AAA\n') // green gone

    undo(v)
    // text restored AND the change is back in matField (the fix) — not empty,
    // which is what made the reconciler re-insert and duplicate.
    expect(v.state.doc.toString()).toBe('AAA\nNEW')
    expect(v.state.field(_matField)).toHaveLength(1)
    expect(v.state.field(_matField)[0].changeId).toBe('c1')
    v.destroy()
  })

  it('KEEP → undo restores the change into matField (delete-red path)', () => {
    const v = view('AAA\nNEW') // red "AAA" [0,3], green "NEW" [4,7]
    v.dispatch({ effects: _setMat.of([mat]) })

    // Keep: delete the RED (green becomes permanent), drop + acceptEffect.
    v.dispatch({ changes: { from: 0, to: 3 }, effects: [_dropChange.of('c1'), _acceptEffect.of('c1')] })
    expect(v.state.field(_matField)).toHaveLength(0)
    expect(v.state.doc.toString()).toBe('\nNEW') // red gone, green kept

    undo(v)
    expect(v.state.doc.toString()).toBe('AAA\nNEW') // red restored
    expect(v.state.field(_matField)).toHaveLength(1) // change back — reconciler won't re-insert
    v.destroy()
  })

  it('redo re-applies the reject (drops it again)', () => {
    const v = view('AAA\nNEW')
    v.dispatch({ effects: _setMat.of([mat]) })
    v.dispatch({ changes: { from: 4, to: 7 }, effects: [_dropChange.of('c1'), _rejectEffect.of('c1')] })
    undo(v)
    redo(v)
    expect(v.state.field(_matField)).toHaveLength(0) // dropped again
    expect(v.state.doc.toString()).toBe('AAA\n')
    v.destroy()
  })
})
