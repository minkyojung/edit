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
import { smartEnter, continueListItemSoft, shiftEnter, enterHandledRecently } from './listEnter'

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

describe('continuationEnter — Enter on an indented continuation (Obsidian UX)', () => {
  it('REPORTED step 4: continuation with content + Enter → NEW same-level bullet', () => {
    const v = mk('- item\n  typed text')
    enter(v)
    expect(v.state.doc.toString()).toBe('- item\n  typed text\n- ')
    v.destroy()
  })

  it('REPORTED step 5: Enter on the empty continuation → exit to column 0 (no stray space)', () => {
    const v = mk('- item\n  typed\n  ')
    enter(v)
    expect(v.state.doc.toString()).toBe('- item\n  typed\n')
    expect(v.state.selection.main.head).toBe(v.state.doc.length)
    v.destroy()
  })

  it('full reported flow: Shift+Enter → type → Enter → type → Enter Enter exits clean', () => {
    const v = mk('- 리스트')
    // Shift+Enter → indented continuation
    expect(shiftEnter(v)).toBe(true)
    type(v, '텍스트')
    // Enter → new bullet (step 4 expectation)
    enter(v)
    expect(v.state.doc.toString()).toBe('- 리스트\n  텍스트\n- ')
    type(v, '둘')
    enter(v) // continue: new bullet
    expect(v.state.doc.toString()).toBe('- 리스트\n  텍스트\n- 둘\n- ')
    enter(v) // empty item → exit (listEnter), column 0, no stray space
    expect(v.state.doc.toString()).toBe('- 리스트\n  텍스트\n- 둘\n')
    expect(v.state.selection.main.head).toBe(v.state.doc.length)
    v.destroy()
  })

  it('ordered: continuation + Enter → next number', () => {
    const v = mk('1. one\n   more')
    enter(v)
    expect(v.state.doc.toString()).toBe('1. one\n   more\n2. ')
    v.destroy()
  })

  it('task: continuation + Enter → fresh unchecked box', () => {
    const v = mk('- [x] done\n  note')
    enter(v)
    expect(v.state.doc.toString()).toBe('- [x] done\n  note\n- [ ] ')
    v.destroy()
  })

  it('nested item continuation → new bullet at the SAME nested level', () => {
    const v = mk('- a\n  - b\n    cont')
    enter(v)
    expect(v.state.doc.toString()).toBe('- a\n  - b\n    cont\n  - ')
    v.destroy()
  })

  it('lazy continuation typed at the margin → NOT ours (plain newline fallback)', () => {
    const v = mk('- item\nlazy')
    enter(v)
    // continuationEnter declines (ws=0); fallback inserts a plain newline, text intact.
    expect(v.state.doc.toString()).toBe('- item\nlazy\n')
    v.destroy()
  })

  it('indented line under a PARAGRAPH (no list above) → not ours', () => {
    const v = mk('paragraph\n  indented')
    enter(v)
    expect(v.state.doc.toString()).toContain('paragraph\n  indented\n')
    expect(v.state.doc.toString()).not.toContain('- ')
    v.destroy()
  })

  it('blank line between item and indented line → list is closed, not ours', () => {
    const v = mk('- item\n\n  stray')
    enter(v)
    expect(v.state.doc.toString()).not.toContain('- \n')
    expect(v.state.doc.toString()).toContain('stray\n')
    v.destroy()
  })
})

describe('shiftEnter — list continuation or plain newline, stamps the Enter signal', () => {
  it('in a list: indents like continueListItemSoft', () => {
    const v = mk('- item')
    expect(shiftEnter(v)).toBe(true)
    expect(v.state.doc.toString()).toBe('- item\n  ')
    v.destroy()
  })
  it('off a list: plain soft newline', () => {
    const v = mk('plain')
    expect(shiftEnter(v)).toBe(true)
    expect(v.state.doc.toString()).toBe('plain\n')
    v.destroy()
  })
  it('stamps enterHandledRecently so the IME beforeinput path dedupes', () => {
    const v = mk('- item')
    shiftEnter(v)
    expect(enterHandledRecently()).toBe(true)
    v.destroy()
  })
})
