// Characterization of inline-marker REVEAL granularity (Phase 0 guard).
//
// `buildDecos` hides a construct's syntax markers (`**`, `*`, `~~`, backticks)
// with a replace decoration UNLESS the caret reveals them. This test pins WHICH
// markers are hidden for a given caret, so the Phase-1 change (line-level →
// per-construct reveal for emphasis/strike/code) flips exactly these assertions
// and nothing else. True IME safety is a real-browser check (Phase 2).

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { _buildDecos, _HIDE } from './livePreview'

// All hidden (replace) ranges for `doc` with a collapsed caret at `caret`.
function hiddenRanges(doc: string, caret: number): Array<[number, number]> {
  const state = EditorState.create({
    doc,
    selection: { anchor: caret },
    extensions: [markdown({ extensions: [GFM] })],
  })
  const out: Array<[number, number]> = []
  for (const r of _buildDecos(state, [{ from: 0, to: state.doc.length }])) {
    if (r.value === _HIDE) out.push([r.from, r.to])
  }
  return out
}
const covers = (ranges: Array<[number, number]>, from: number, to: number) =>
  ranges.some(([f, t]) => f === from && t === to)

// `한국어 **굵게** 텍스트` on line 1, a second line below. Offsets:
// 한0 국1 어2 ␣3 *4 *5 굵6 게7 *8 *9 ␣10 텍11 스12 트13 \n14 다15…
const DOC = '한국어 **굵게** 텍스트\n다음 줄'
const OPEN: [number, number] = [4, 6] // opening `**`
const CLOSE: [number, number] = [8, 10] // closing `**`

describe('emphasis reveal granularity (per-construct)', () => {
  it('caret OFF the line → markers hidden (invariant across phases)', () => {
    const h = hiddenRanges(DOC, 16) // on line 2
    expect(covers(h, ...OPEN)).toBe(true)
    expect(covers(h, ...CLOSE)).toBe(true)
  })

  it('caret INSIDE the bold → markers revealed (invariant across phases)', () => {
    const h = hiddenRanges(DOC, 7) // between 굵 and 게
    expect(covers(h, ...OPEN)).toBe(false)
    expect(covers(h, ...CLOSE)).toBe(false)
  })

  it('caret on the line but OUTSIDE the bold → markers stay hidden (per-construct)', () => {
    const h = hiddenRanges(DOC, 12) // in 텍스트, after the bold
    // The fix: a caret elsewhere on the line no longer pops the bold raw.
    expect(covers(h, ...OPEN)).toBe(true)
    expect(covers(h, ...CLOSE)).toBe(true)
  })
})

// `- [[노트]] 그리고 긴 문장` — bullet line with a wikilink, then prose. Offsets:
// -0 ␣1 [2 [3 노4 트5 ]6 ]7 ␣8 그9 리10 …
const WIKI = '- [[노트]] 그리고 긴 문장'
const LB: [number, number] = [2, 4] // `[[`
const RB: [number, number] = [6, 8] // `]]`

describe('wikilink bracket reveal granularity (per-construct)', () => {
  it('caret OUTSIDE the wikilink (in the prose) → brackets hidden', () => {
    const h = hiddenRanges(WIKI, 11) // in 그리고
    expect(covers(h, ...LB)).toBe(true)
    expect(covers(h, ...RB)).toBe(true)
  })

  it('caret INSIDE the wikilink → brackets revealed (not hidden)', () => {
    const h = hiddenRanges(WIKI, 5) // between 노 and 트
    expect(covers(h, ...LB)).toBe(false)
    expect(covers(h, ...RB)).toBe(false)
  })
})
