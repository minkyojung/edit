// Step A measurement: how much of our desired editing behavior does CM give
// for FREE? Runs the stock markdown commands (Enter/Backspace) +
// indentMore/indentLess (Tab) on EditorStates and asserts the result. Each
// passing test = a behavior we DON'T have to build. Failures map the gaps to
// fill later (B/C/D). See docs/archive/codemirror-editing-behavior-plan.md.

import { describe, expect, it } from 'vitest'
import { EditorState, type StateCommand } from '@codemirror/state'
import { ensureSyntaxTree, indentUnit } from '@codemirror/language'
import { indentMore, indentLess } from '@codemirror/commands'
import {
  markdown,
  insertNewlineContinueMarkup,
  deleteMarkupBackward,
} from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'

function stateAt(doc: string, pos: number): EditorState {
  const state = EditorState.create({
    doc,
    selection: { anchor: pos },
    extensions: [indentUnit.of('  '), markdown({ extensions: [GFM] })],
  })
  ensureSyntaxTree(state, doc.length, 5000)
  return state
}

function run(state: EditorState, cmd: StateCommand): { doc: string; handled: boolean } {
  let next = state
  const handled = cmd({ state, dispatch: (tr) => { next = tr.state } })
  return { doc: next.doc.toString(), handled }
}

describe('CM free editing behavior — Enter (list continuation)', () => {
  it('L1 bullet: Enter at end → new bullet', () => {
    const r = run(stateAt('- item', 6), insertNewlineContinueMarkup)
    expect(r.handled).toBe(true)
    expect(r.doc).toBe('- item\n- ')
  })

  it('L1 ordered: Enter at end → next number', () => {
    const r = run(stateAt('1. item', 7), insertNewlineContinueMarkup)
    expect(r.handled).toBe(true)
    expect(r.doc).toBe('1. item\n2. ')
  })

  it('L2 empty item: Enter → exits the list (marker removed)', () => {
    const r = run(stateAt('- ', 2), insertNewlineContinueMarkup)
    expect(r.handled).toBe(true)
    expect(r.doc.includes('- ')).toBe(false) // no leftover bullet
  })

  it('L3 task: Enter → new UNCHECKED checkbox', () => {
    const r = run(stateAt('- [ ] task', 10), insertNewlineContinueMarkup)
    expect(r.handled).toBe(true)
    expect(r.doc).toBe('- [ ] task\n- [ ] ')
  })

  it('L3b checked task: Enter → next item is unchecked', () => {
    const r = run(stateAt('- [x] done', 10), insertNewlineContinueMarkup)
    expect(r.handled).toBe(true)
    expect(r.doc.endsWith('- [ ] ')).toBe(true)
  })

  it('H1 heading: Enter is NOT continued → falls through to plain newline', () => {
    // insertNewlineContinueMarkup returns false for a heading, so the default
    // Enter (plain newline) runs → next line is a normal paragraph.
    const r = run(stateAt('# Title', 7), insertNewlineContinueMarkup)
    expect(r.handled).toBe(false)
  })
})

describe('CM free editing behavior — Backspace (markup delete)', () => {
  it('L4 backspace at start of content → removes the bullet marker', () => {
    const r = run(stateAt('- item', 2), deleteMarkupBackward)
    expect(r.handled).toBe(true)
    expect(r.doc).toBe('item')
  })
})

describe('CM free editing behavior — Tab indent/outdent', () => {
  it('Tab: indentMore adds one indent unit (nests the list item)', () => {
    const r = run(stateAt('- item', 3), indentMore)
    expect(r.handled).toBe(true)
    expect(r.doc).toBe('  - item')
  })

  it('Shift+Tab: indentLess removes one indent unit', () => {
    const r = run(stateAt('  - item', 5), indentLess)
    expect(r.handled).toBe(true)
    expect(r.doc).toBe('- item')
  })
})
