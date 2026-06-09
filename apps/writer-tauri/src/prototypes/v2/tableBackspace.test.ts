import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { forceParsing } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { tableBackspace } from './tableBackspace'

const TABLE = '| Feature | PM |\n| --- | --- |\n| Anchor | 724 |'

function mk(doc: string, caret: number) {
  const v = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, selection: { anchor: caret }, extensions: [markdown({ extensions: [GFM], addKeymap: false })] }),
  })
  forceParsing(v, v.state.doc.length, 1e9)
  return v
}

describe('tableBackspace — swallow only at the dangerous table boundary', () => {
  it('DANGEROUS: blank between table and paragraph → select table, doc unchanged', () => {
    const v = mk(`${TABLE}\n\nMEDIA paragraph.`, TABLE.length + 1)
    expect(tableBackspace(v)).toBe(true)
    expect(v.state.doc.toString()).toBe(`${TABLE}\n\nMEDIA paragraph.`) // not deleted
    const sel = v.state.selection.main
    expect([sel.from, sel.to]).toEqual([0, TABLE.length]) // whole table selected
    v.destroy()
  })
  it('SAFE: trailing blank at end of doc → not intercepted', () => {
    const v = mk(`${TABLE}\n`, `${TABLE}\n`.length)
    expect(tableBackspace(v)).toBe(false)
    v.destroy()
  })
  it('SAFE: two blanks below → not intercepted (a blank remains)', () => {
    const v = mk(`${TABLE}\n\n\nMEDIA.`, TABLE.length + 1)
    expect(tableBackspace(v)).toBe(false)
    v.destroy()
  })
  it('SAFE: blank not after a table → not intercepted', () => {
    const v = mk(`a paragraph\n\nMEDIA.`, 'a paragraph'.length + 1)
    expect(tableBackspace(v)).toBe(false)
    v.destroy()
  })
  it('SAFE: caret not on a blank line → not intercepted', () => {
    const v = mk(`${TABLE}\n\nMEDIA paragraph.`, `${TABLE}\n\nMEDIA paragraph.`.length)
    expect(tableBackspace(v)).toBe(false)
    v.destroy()
  })
})
