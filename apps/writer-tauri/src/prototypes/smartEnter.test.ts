// Full-chain Enter tests (smartEnter + the real markdown parser), reproducing the
// reported bug: exit an empty item → type → Enter must NOT delete the typed text.
// This exercises the lazy-continuation case (a non-marker paragraph parsed as part
// of a task item) that CM's insertNewlineContinueMarkup mishandled for TASKS.
import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { forceParsing } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { smartEnter, continueListItemSoft } from './listEnter'

function mk(doc: string) {
  const v = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, extensions: [markdown({ extensions: [GFM], addKeymap: false })] }),
  })
  v.dispatch({ selection: { anchor: doc.length } })
  return v
}
function enter(v: EditorView) {
  forceParsing(v, v.state.doc.length, 1e9) // real app parses between keystrokes
  return smartEnter(v)
}
function type(v: EditorView, t: string) {
  const at = v.state.selection.main.head
  v.dispatch({ changes: { from: at, insert: t }, selection: { anchor: at + t.length } })
  forceParsing(v, v.state.doc.length, 1e9)
}

describe('smartEnter — exit then retype then Enter keeps text (parser in the loop)', () => {
  it('TASK: text survives', () => {
    const v = mk('- [ ] task\n- [ ] ')
    enter(v) // exit empty task
    expect(v.state.doc.toString()).toBe('- [ ] task\n')
    type(v, 'hello')
    enter(v)
    expect(v.state.doc.toString()).toContain('hello') // the bug: was deleted
    expect(v.state.doc.toString()).toBe('- [ ] task\nhello\n')
    v.destroy()
  })

  it('BULLET: text survives', () => {
    const v = mk('- item\n- ')
    enter(v)
    expect(v.state.doc.toString()).toBe('- item\n')
    type(v, 'hello')
    enter(v)
    expect(v.state.doc.toString()).toBe('- item\nhello\n')
    v.destroy()
  })

  it('blockquote still continues', () => {
    const v = mk('> quote')
    enter(v)
    expect(v.state.doc.toString()).toBe('> quote\n> ')
    v.destroy()
  })
})

describe('continueListItemSoft — Shift+Enter indents the continuation to the content column', () => {
  it('bullet: newline + 2 spaces (content col of "- ")', () => {
    const v = mk('- item')
    expect(continueListItemSoft(v)).toBe(true)
    expect(v.state.doc.toString()).toBe('- item\n  ')
    v.destroy()
  })
  it('ordered: newline + 3 spaces (content col of "1. ")', () => {
    const v = mk('1. item')
    expect(continueListItemSoft(v)).toBe(true)
    expect(v.state.doc.toString()).toBe('1. item\n   ')
    v.destroy()
  })
  it('task: content col excludes the checkbox (2 spaces after "- ")', () => {
    const v = mk('- [ ] task')
    expect(continueListItemSoft(v)).toBe(true)
    expect(v.state.doc.toString()).toBe('- [ ] task\n  ')
    v.destroy()
  })
  it('already-indented continuation: mirrors its own indent', () => {
    const v = mk('- item\n  cont')
    expect(continueListItemSoft(v)).toBe(true)
    expect(v.state.doc.toString()).toBe('- item\n  cont\n  ')
    v.destroy()
  })
  it('flush-left non-list line: returns false, leaves the doc untouched', () => {
    const v = mk('plain paragraph')
    expect(continueListItemSoft(v)).toBe(false)
    expect(v.state.doc.toString()).toBe('plain paragraph')
    v.destroy()
  })
})
