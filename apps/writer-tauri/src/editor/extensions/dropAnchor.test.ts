// Audit C1 (core): a media drop's insertion point must MAP through edits made while the
// file imports, not stay at a stale offset. dropAnchorField tracks the point and maps it
// on every doc change; these pin that mapping (and multi-anchor independence + clearing).

import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { dropAnchorField, addDropAnchor, clearDropAnchor } from './dropAnchor'

function withField(doc: string) {
  return EditorState.create({ doc, extensions: [dropAnchorField] })
}

describe('dropAnchorField (C1)', () => {
  it('maps a pending anchor through inserts and deletes before it', () => {
    let state = withField('hello world')
    state = state.update({ effects: addDropAnchor.of({ id: 1, pos: 5 }) }).state
    expect(state.field(dropAnchorField).get(1)).toBe(5)
    state = state.update({ changes: { from: 0, insert: 'XYZ' } }).state // +3 before it
    expect(state.field(dropAnchorField).get(1)).toBe(8)
    state = state.update({ changes: { from: 0, to: 2 } }).state // −2 before it
    expect(state.field(dropAnchorField).get(1)).toBe(6)
  })

  it('tracks several concurrent anchors independently', () => {
    let state = withField('abcdef')
    state = state
      .update({ effects: [addDropAnchor.of({ id: 1, pos: 1 }), addDropAnchor.of({ id: 2, pos: 5 })] })
      .state
    state = state.update({ changes: { from: 0, insert: 'ZZ' } }).state
    expect(state.field(dropAnchorField).get(1)).toBe(3)
    expect(state.field(dropAnchorField).get(2)).toBe(7)
  })

  it('clears an anchor on clearDropAnchor', () => {
    let state = withField('abc')
    state = state.update({ effects: addDropAnchor.of({ id: 9, pos: 2 }) }).state
    expect(state.field(dropAnchorField).has(9)).toBe(true)
    state = state.update({ effects: clearDropAnchor.of(9) }).state
    expect(state.field(dropAnchorField).has(9)).toBe(false)
  })
})
