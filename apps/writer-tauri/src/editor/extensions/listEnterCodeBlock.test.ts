// Regression proof for audit B1: smartEnter/shiftEnter are pure line-text regex with
// no tree awareness, so a `- x` line INSIDE a fenced code block used to match LIST_RE
// and get a `- ` marker manufactured into the code on Enter — silent content
// corruption. The fix guards both entry points with inCodeBlock() and falls to a plain
// indented newline. The real markdown parser is in the loop (forceParsing) so the guard
// sees a genuine FencedCode node.

import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { forceParsing } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { smartEnter, shiftEnter } from './listEnter'

function mk(doc: string, caret: number) {
  const v = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, extensions: [markdown({ extensions: [GFM], addKeymap: false })] }),
  })
  v.dispatch({ selection: { anchor: caret } })
  forceParsing(v, v.state.doc.length, 1e9)
  return v
}

describe('Enter inside a fenced code block does not inject list markup (B1)', () => {
  it('smartEnter on a "- item" line inside ``` fences → plain newline, NO marker', () => {
    const doc = '```\n- item\n```'
    const v = mk(doc, doc.indexOf('- item') + '- item'.length) // end of the code line
    const handled = smartEnter(v)
    expect(handled).toBe(true)
    expect(v.state.doc.toString()).toBe('```\n- item\n\n```') // blank line, no "- "
    v.destroy()
  })

  it('smartEnter on an ordered "1. x" line inside fences → no "2." injected', () => {
    const doc = '```\n1. x\n```'
    const v = mk(doc, doc.indexOf('1. x') + '1. x'.length)
    smartEnter(v)
    expect(v.state.doc.toString()).toBe('```\n1. x\n\n```') // no "2. "
    v.destroy()
  })

  it('shiftEnter inside fences → plain newline, not a marker-column soft continuation', () => {
    const doc = '```\n- item\n```'
    const v = mk(doc, doc.indexOf('- item') + '- item'.length)
    shiftEnter(v)
    expect(v.state.doc.toString()).toBe('```\n- item\n\n```')
    v.destroy()
  })

  it('the guard is scoped: the SAME "- item" as a real list still continues with a marker', () => {
    const doc = '- item'
    const v = mk(doc, doc.length)
    smartEnter(v)
    expect(v.state.doc.toString()).toBe('- item\n- ')
    v.destroy()
  })
})
