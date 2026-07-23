// Guards the selection-change rebuild gate (blocksField). The block-decoration
// field used to re-scan the ENTIRE syntax tree on every cursor move; it now
// rebuilds only when the caret enters/leaves a reveal-capable block line (image /
// media). These tests pin (1) the gate predicate and (2) that reveal still works
// end-to-end through the field.

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { blocksV2, _selectionNearBlock, _blocksField } from './blocks'

const mk = (doc: string, caret: number) =>
  EditorState.create({
    doc,
    selection: { anchor: caret },
    extensions: [markdown({ extensions: [GFM] }), blocksV2],
  })

// A prose paragraph, an image line, then a media line.
//                    1         2         3         4
//          0123456789012345678901234567890123456789012345
const DOC = 'hello world\n![alt](pic.png)\n<video src="v.mp4"></video>\ntail'
const IMG_LINE = DOC.indexOf('![') // 12
const VIDEO_LINE = DOC.indexOf('<video') // 28

describe('selectionNearBlock (the rebuild gate predicate)', () => {
  it('is false for a caret in plain prose', () => {
    expect(_selectionNearBlock(mk(DOC, 3))).toBe(false) // inside "hello"
    expect(_selectionNearBlock(mk(DOC, DOC.length - 1))).toBe(false) // "tail"
  })

  it('is true for a caret on an image line', () => {
    expect(_selectionNearBlock(mk(DOC, IMG_LINE + 4))).toBe(true)
  })

  it('is true for a caret on a <video> media line', () => {
    expect(_selectionNearBlock(mk(DOC, VIDEO_LINE + 2))).toBe(true)
  })

  it('is true for a selection that SPANS a block line even if neither endpoint is on it', () => {
    // from inside "hello world" (line 1) to inside "tail" (line 4) — the image and
    // video lines sit between the endpoints, so a rebuild must fire to reveal them.
    const state = EditorState.create({
      doc: DOC,
      selection: { anchor: 3, head: DOC.length - 1 },
      extensions: [markdown({ extensions: [GFM] }), blocksV2],
    })
    expect(_selectionNearBlock(state)).toBe(true)
  })
})

// The decoration ranges ([from, to]) currently in the field.
function ranges(state: EditorState): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const cursor = state.field(_blocksField).iter()
  while (cursor.value) {
    out.push([cursor.from, cursor.to])
    cursor.next()
  }
  return out
}

describe('reveal still works through the gated field', () => {
  it('rebuilds when a selection change moves the caret onto the image line', () => {
    // Caret off the image → the image source is REPLACED by the widget, so a
    // decoration spans the raw `![alt](pic.png)` range.
    let state = mk(DOC, 3)
    const off = ranges(state)
    const imgEnd = state.doc.lineAt(IMG_LINE).to
    expect(off).toContainEqual([IMG_LINE, imgEnd]) // source hidden (replaced)

    // Move the caret onto the image line via a selection-only transaction. The gate
    // must let the rebuild through so the image reveals: the source range is no
    // longer replaced, and a block widget is added at the line END (a point deco).
    state = state.update({ selection: { anchor: IMG_LINE + 4 } }).state
    const on = ranges(state)
    expect(on).not.toContainEqual([IMG_LINE, imgEnd]) // source now shown raw
    expect(on).toContainEqual([imgEnd, imgEnd]) // preview widget below the source
  })

  it('keeps the field stable when the caret moves between two prose lines', () => {
    let state = mk(DOC, 3) // in "hello"
    const before = state.field(_blocksField)
    // Move within prose (line 1 → line 4 "tail"), never touching a block line.
    state = state.update({ selection: { anchor: DOC.length - 2 } }).state
    const after = state.field(_blocksField)
    // No rebuild → the mapped set is carried through unchanged (same instance).
    expect(after).toBe(before)
  })
})
