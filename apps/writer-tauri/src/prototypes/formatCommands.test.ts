// Headless proof for format toggle + link commands.

import { describe, expect, it } from 'vitest'
import { EditorState, type StateCommand } from '@codemirror/state'
import { toggleWrap, insertLink } from './formatCommands'

function run(doc: string, anchor: number, head: number, cmd: StateCommand) {
  const state = EditorState.create({ doc, selection: { anchor, head } })
  let next = state
  cmd({ state, dispatch: (tr) => { next = tr.state } })
  return { doc: next.doc.toString(), sel: next.selection.main }
}

describe('toggleWrap', () => {
  it('wraps a selection (bold)', () => {
    const r = run('hello', 0, 5, toggleWrap('**'))
    expect(r.doc).toBe('**hello**')
    // selection stays on the inner text
    expect([r.sel.from, r.sel.to]).toEqual([2, 7])
  })

  it('round-trips: toggling again unwraps', () => {
    // selection is the inner "hello" of "**hello**"
    const r = run('**hello**', 2, 7, toggleWrap('**'))
    expect(r.doc).toBe('hello')
    expect([r.sel.from, r.sel.to]).toEqual([0, 5])
  })

  it('empty selection inserts a marker pair with caret between', () => {
    const r = run('', 0, 0, toggleWrap('**'))
    expect(r.doc).toBe('****')
    expect(r.sel.from).toBe(2)
  })

  it('italic + code markers', () => {
    expect(run('x', 0, 1, toggleWrap('*')).doc).toBe('*x*')
    expect(run('x', 0, 1, toggleWrap('`')).doc).toBe('`x`')
  })
})

describe('insertLink (Cmd+K)', () => {
  it('wraps selection as [text]() with caret inside ()', () => {
    const r = run('text', 0, 4, insertLink)
    expect(r.doc).toBe('[text]()')
    expect(r.sel.from).toBe(7) // between ( and )
  })

  it('empty selection inserts []() with caret inside []', () => {
    const r = run('', 0, 0, insertLink)
    expect(r.doc).toBe('[]()')
    expect(r.sel.from).toBe(1)
  })
})
