import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { listEnter } from './listEnter'

function view(doc: string, caret = doc.length) {
  return new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, selection: { anchor: caret } }),
  })
}

describe('listEnter — deterministic, tight, no blank lines', () => {
  it('bullet continue (tight)', () => {
    const v = view('- hello')
    expect(listEnter(v)).toBe(true)
    expect(v.state.doc.toString()).toBe('- hello\n- ')
    v.destroy()
  })

  it('bullet empty → clean exit (no blank line)', () => {
    const v = view('- hello\n- ')
    expect(listEnter(v)).toBe(true)
    expect(v.state.doc.toString()).toBe('- hello\n')
    v.destroy()
  })

  it('ordered continue increments', () => {
    const v = view('1. one')
    expect(listEnter(v)).toBe(true)
    expect(v.state.doc.toString()).toBe('1. one\n2. ')
    v.destroy()
  })

  it('task continue → fresh unchecked', () => {
    const v = view('- [x] done')
    expect(listEnter(v)).toBe(true)
    expect(v.state.doc.toString()).toBe('- [x] done\n- [ ] ')
    v.destroy()
  })

  it('task empty → clean exit', () => {
    const v = view('- [ ] task\n- [ ] ')
    expect(listEnter(v)).toBe(true)
    expect(v.state.doc.toString()).toBe('- [ ] task\n')
    v.destroy()
  })

  it('nested empty → outdent one level (keeps marker)', () => {
    const v = view('- a\n  - ')
    expect(listEnter(v)).toBe(true)
    expect(v.state.doc.toString()).toBe('- a\n- ')
    v.destroy()
  })

  it('retype after exit + Enter keeps the text (the reported bug)', () => {
    // exit an empty item → type → Enter must NOT delete the typed text
    const v = view('- [ ] task\n- [ ] ')
    listEnter(v) // exit → "- [ ] task\n"
    const at = v.state.doc.length
    v.dispatch({ changes: { from: at, insert: 'hello' }, selection: { anchor: at + 5 } })
    expect(listEnter(v)).toBe(false) // "hello" is not a list → falls back
    expect(v.state.doc.toString()).toContain('hello') // text survives
    v.destroy()
  })

  it('non-list → returns false (caller falls back)', () => {
    const v = view('just text')
    expect(listEnter(v)).toBe(false)
    v.destroy()
  })

  it('mid-line split keeps tight', () => {
    const v = view('- abcdef', 5) // caret after "abc"
    expect(listEnter(v)).toBe(true)
    expect(v.state.doc.toString()).toBe('- abc\n- def')
    v.destroy()
  })
})
