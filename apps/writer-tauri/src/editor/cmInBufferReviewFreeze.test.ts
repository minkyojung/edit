// The red (old, to-be-replaced) text of a pending proposal is read-only: a user
// edit touching it is dropped; edits elsewhere and programmatic transactions pass.
// (Ported from the old widget review's freeze test — same rule, now keyed on the
// in-buffer review's matField red ranges.)
import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { _matField, _setMat, _freezeOldText } from './cmInBufferReview'

// A proposal whose RED (old) span is "AAA" [0,3]; green is irrelevant here.
const mat = {
  changeId: 'c1',
  hunks: [{ redFrom: 0, redTo: 3, greenFrom: 4, greenTo: 7, kind: 'replace' as const }],
}

function seed(doc: string) {
  let state = EditorState.create({ doc, extensions: [_matField, _freezeOldText] })
  state = state.update({ effects: _setMat.of([mat]) }).state
  return state
}

describe('freezeOldText — red (old) text is read-only', () => {
  it('blocks a user DELETE inside the red span', () => {
    const s = seed('AAA\nNEW')
    const tr = s.update({ changes: { from: 1, to: 2 }, userEvent: 'delete.backward' })
    expect(tr.state.doc.toString()).toBe('AAA\nNEW') // unchanged
  })

  it('blocks a user INSERT inside the red span', () => {
    const s = seed('AAA\nNEW')
    const tr = s.update({ changes: { from: 2, insert: 'z' }, userEvent: 'input.type' })
    expect(tr.state.doc.toString()).toBe('AAA\nNEW')
  })

  it('ALLOWS a user edit elsewhere (the green / body)', () => {
    const s = seed('AAA\nNEW')
    const tr = s.update({ changes: { from: 5, insert: 'z' }, userEvent: 'input.type' })
    expect(tr.state.doc.toString()).toBe('AAA\nNzEW')
  })

  it('ALLOWS programmatic edits into the red span (accept/reject apply)', () => {
    const s = seed('AAA\nNEW')
    const tr = s.update({ changes: { from: 0, to: 3, insert: '' } }) // no userEvent
    expect(tr.state.doc.toString()).toBe('\nNEW')
  })
})
