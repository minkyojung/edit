// Regression proof for audit E1: youtube/mermaid card fields rebuilt the ENTIRE
// decoration set (a full syntax-tree walk) on EVERY selection change — every arrow key
// / click anywhere in the doc — instead of only when the caret enters/leaves a card,
// which blocks.ts already gates. We observe the gate cheaply: a selection-only
// transaction has an EMPTY change set, and RangeSet.map(empty) returns the SAME
// instance, so when the gate keeps the mapped set the field value is reference-identical
// across the move; a rebuild returns a fresh set. Far-from-card caret moves must keep
// the set; moving onto a card line must rebuild (and hide the widget for editing).

import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { Decoration, type DecorationSet } from '@codemirror/view'
import { forceParsing } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { youtubeField } from './youtubeCards'
import { mermaidField } from './mermaidCards'

function widgetCount(set: DecorationSet): number {
  let n = 0
  set.between(0, 1e9, (_f, _t, d) => {
    if (d instanceof Decoration && d.spec.widget) n++
  })
  return n
}

function mk(doc: string, field: typeof youtubeField) {
  const v = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, extensions: [markdown({ extensions: [GFM], addKeymap: false }), field] }),
  })
  forceParsing(v, v.state.doc.length, 1e9)
  return v
}

describe('card fields — selection gate (E1)', () => {
  it('youtube: a caret move through prose keeps the mapped set (no rebuild); onto the URL rebuilds', () => {
    const doc = 'https://youtu.be/abcdefghijk\n\nfirst prose line\nsecond prose line'
    const v = mk(doc, youtubeField)
    // Caret into prose → the card renders (caret left the URL line).
    v.dispatch({ selection: { anchor: doc.length } })
    const set1 = v.state.field(youtubeField)
    expect(widgetCount(set1)).toBe(1)
    // Move the caret WITHIN prose, far from the card → gate keeps the set (same ref).
    v.dispatch({ selection: { anchor: doc.length - 3 } })
    expect(v.state.field(youtubeField)).toBe(set1) // no rebuild
    // Move onto the URL line → rebuild, widget hidden (raw URL for editing).
    v.dispatch({ selection: { anchor: 5 } })
    const set3 = v.state.field(youtubeField)
    expect(set3).not.toBe(set1)
    expect(widgetCount(set3)).toBe(0)
    v.destroy()
  })

  it('mermaid: a caret move through prose keeps the set; into the fence rebuilds (reveal)', () => {
    const doc = '```mermaid\ngraph TD\nA-->B\n```\n\nprose line one\nprose two'
    const v = mk(doc, mermaidField)
    v.dispatch({ selection: { anchor: doc.length } })
    const set1 = v.state.field(mermaidField)
    expect(widgetCount(set1)).toBe(1)
    v.dispatch({ selection: { anchor: doc.length - 3 } })
    expect(v.state.field(mermaidField)).toBe(set1) // no rebuild through prose
    // Caret into the fence BODY (a line with no marker/`mermaid` text) → reveal.
    v.dispatch({ selection: { anchor: doc.indexOf('A-->B') } })
    const set3 = v.state.field(mermaidField)
    expect(set3).not.toBe(set1)
    expect(widgetCount(set3)).toBe(0)
    v.destroy()
  })
})
