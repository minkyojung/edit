// Headless proof for the highlight layer: offset anchoring + occurrence index
// + records→decorations. (Mark styling/click are thin shells.)

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import {
  rangeFor,
  occurrenceAt,
  highlights,
  highlightField,
  type HighlightRecord,
} from './highlights'

describe('rangeFor (offset anchoring by quote + occurrence)', () => {
  const text = 'the cat and the cat again'
  it('first occurrence', () => {
    expect(rangeFor(text, 'cat', 0)).toEqual({ from: 4, to: 7 })
  })
  it('second occurrence', () => {
    expect(rangeFor(text, 'cat', 1)).toEqual({ from: 16, to: 19 })
  })
  it('missing → null', () => {
    expect(rangeFor(text, 'dog', 0)).toBeNull()
    expect(rangeFor(text, 'cat', 2)).toBeNull()
  })
})

describe('occurrenceAt (recording a new highlight)', () => {
  const text = 'the cat and the cat again'
  it('counts matches before the selection start', () => {
    expect(occurrenceAt(text, 'cat', 4)).toBe(0)
    expect(occurrenceAt(text, 'cat', 16)).toBe(1)
  })
})

describe('records → decorations', () => {
  function highlightRanges(doc: string, records: HighlightRecord[]) {
    const state = EditorState.create({ doc, extensions: [highlights(records)] })
    const set = state.field(highlightField)
    const out: Array<{ from: number; to: number }> = []
    set.between(0, doc.length, (from, to) => {
      out.push({ from, to })
    })
    return out
  }

  it('paints a mark per resolvable record (correct occurrence)', () => {
    const doc = 'the cat and the cat again'
    const ranges = highlightRanges(doc, [
      { id: 'a', quote: 'cat', occurrence: 1 },
      { id: 'b', quote: 'again', occurrence: 0 },
    ])
    expect(ranges).toEqual([
      { from: 16, to: 19 },
      { from: 20, to: 25 },
    ])
  })

  it('drops records whose quote is gone', () => {
    expect(highlightRanges('no match here', [{ id: 'x', quote: 'ghost', occurrence: 0 }])).toEqual([])
  })
})
