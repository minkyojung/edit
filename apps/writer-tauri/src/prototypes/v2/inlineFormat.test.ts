import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { _toggleWrap, _toggleLink } from './inlineFormat'

function mk(doc: string, from: number, to = from) {
  return new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, selection: { anchor: from, head: to } }),
  })
}
const sel = (v: EditorView) => [v.state.selection.main.from, v.state.selection.main.to]

const bold = _toggleWrap('**')
const italic = _toggleWrap('*')
const code = _toggleWrap('`')

describe('toggleWrap', () => {
  it('wraps a selection, content stays selected', () => {
    const v = mk('hello', 0, 5)
    bold(v)
    expect(v.state.doc.toString()).toBe('**hello**')
    expect(sel(v)).toEqual([2, 7]) // "hello" still selected
    v.destroy()
  })

  it('un-toggles when pressed again (selection already wrapped)', () => {
    const v = mk('**hello**', 2, 7) // "hello" selected
    bold(v)
    expect(v.state.doc.toString()).toBe('hello')
    expect(sel(v)).toEqual([0, 5])
    v.destroy()
  })

  it('italic uses single star', () => {
    const v = mk('hi', 0, 2)
    italic(v)
    expect(v.state.doc.toString()).toBe('*hi*')
    v.destroy()
  })

  it('inline code', () => {
    const v = mk('x', 0, 1)
    code(v)
    expect(v.state.doc.toString()).toBe('`x`')
    v.destroy()
  })

  it('collapsed caret in a word → wraps the whole word', () => {
    const v = mk('hello', 2) // caret inside "hello"
    bold(v)
    expect(v.state.doc.toString()).toBe('**hello**')
    v.destroy()
  })

  it('collapsed caret on empty → inserts pair, caret in middle', () => {
    const v = mk('', 0)
    bold(v)
    expect(v.state.doc.toString()).toBe('****')
    expect(sel(v)).toEqual([2, 2])
    v.destroy()
  })

  it('trims whitespace inward', () => {
    const v = mk(' hi ', 0, 4) // select the whole thing incl. spaces
    bold(v)
    expect(v.state.doc.toString()).toBe(' **hi** ')
    v.destroy()
  })

  it('italic on text already bold adds (does not mistake ** for *)', () => {
    const v = mk('**x**', 2, 3) // select "x" inside bold
    italic(v)
    expect(v.state.doc.toString()).toBe('**​*x*​**'.replace(/​/g, '')) // ***x***
    v.destroy()
  })
})

describe('toggleLink', () => {
  it('wraps selection, caret inside ()', () => {
    const v = mk('google', 0, 6)
    _toggleLink(v)
    expect(v.state.doc.toString()).toBe('[google]()')
    expect(sel(v)).toEqual([9, 9]) // inside the ()
    v.destroy()
  })

  it('collapsed → [](), caret inside []', () => {
    const v = mk('', 0)
    _toggleLink(v)
    expect(v.state.doc.toString()).toBe('[]()')
    expect(sel(v)).toEqual([1, 1])
    v.destroy()
  })
})
