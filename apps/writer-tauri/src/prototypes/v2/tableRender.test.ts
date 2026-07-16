// Regression: a GFM table must render as the editable widget whether it's present
// at mount OR inserted later. The block-decoration field only calls build() when a
// change/selection actually involves a block; a table is neither near an existing
// widget nor on an `![` line, so the field must recognize the Table node itself.
// (Guards the fix for the "inserted table stays raw markdown" regression.)

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { blocksV2, _blocksField } from './blocks'

const TABLE = '| 항목 | 내용 |\n| --- | --- |\n| 예시 1 | 예시 값 |\n| 예시 2 | 예시 값 |'
const VIDEO = '<video src="v.mp4"></video>'

function hasWidget(state: EditorState, name: string): boolean {
  let found = false
  const cur = state.field(_blocksField).iter()
  while (cur.value) {
    const w = (cur.value.spec as { widget?: { constructor: { name: string } } }).widget
    if (w && w.constructor.name === name) found = true
    cur.next()
  }
  return found
}
const hasTableWidget = (s: EditorState) => hasWidget(s, 'EditableTableWidget')

const mk = (doc: string, anchor = 0) =>
  EditorState.create({
    doc,
    selection: { anchor },
    extensions: [markdown({ extensions: [GFM] }), blocksV2],
  })

describe('table renders as a widget', () => {
  it('when present at mount', () => {
    expect(hasTableWidget(mk(TABLE))).toBe(true)
  })

  it('when inserted after mount (the reported regression)', () => {
    let state = mk('hello\n\n', 0)
    expect(hasTableWidget(state)).toBe(false)
    state = state.update({ changes: { from: state.doc.length, insert: TABLE } }).state
    // Renders on the insert itself (docChanged → touchesBlocks sees the Table node).
    expect(hasTableWidget(state)).toBe(true)
  })

  it('survives a caret move away from it', () => {
    let state = mk(`${TABLE}\n\ntail`, 0)
    state = state.update({ selection: { anchor: state.doc.length } }).state
    expect(hasTableWidget(state)).toBe(true)
  })
})

describe('media renders as a widget', () => {
  it('when inserted after mount (touchesBlocks detects the <video> line)', () => {
    let state = mk('hello\n\n', 0)
    expect(hasWidget(state, 'MediaWidget')).toBe(false)
    state = state.update({ changes: { from: state.doc.length, insert: VIDEO } }).state
    expect(hasWidget(state, 'MediaWidget')).toBe(true)
  })
})
