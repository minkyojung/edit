// Physical proof for the document-level Cmd-Z/Cmd-Shift-Z router. We mount a REAL
// EditorView with history() so undo/redo actually move the doc — then dispatch a
// document keydown (as the chat-panel-focused case does) and assert the doc changed.
// The focus guard (INPUT/TEXTAREA/contentEditable owns its own undo) and the cleanup
// are the two seams that would silently break Cmd-Z, so they're pinned here.

import { describe, it, expect, afterEach } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history } from '@codemirror/commands'
import { installUndoRouter } from './undoRouter'

function mountWithEdit() {
  // Start at 'hello', then apply an undoable insert → 'hello!'. Undo should revert to
  // 'hello', redo back to 'hello!'.
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: 'hello', extensions: [history()] }),
  })
  view.dispatch({ changes: { from: 5, insert: '!' } })
  return view
}

// Fire a document-level keydown; returns whether the router called preventDefault.
function pressKey(opts: { key: string; meta?: boolean; shift?: boolean }): boolean {
  const e = new KeyboardEvent('keydown', {
    key: opts.key,
    metaKey: opts.meta ?? false,
    shiftKey: opts.shift ?? false,
    bubbles: true,
    cancelable: true,
  })
  document.dispatchEvent(e)
  return e.defaultPrevented
}

let cleanup: (() => void) | null = null
let view: EditorView | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
  view?.destroy()
  view = null
  // Reset focus so the body (not a leftover input) is the activeElement next test.
  ;(document.activeElement as HTMLElement | null)?.blur?.()
})

describe('installUndoRouter', () => {
  it('routes Cmd-Z into the view → actually undoes the doc', () => {
    view = mountWithEdit()
    expect(view.state.doc.toString()).toBe('hello!')
    cleanup = installUndoRouter(() => view)
    const prevented = pressKey({ key: 'z', meta: true })
    expect(view.state.doc.toString()).toBe('hello') // reverted
    expect(prevented).toBe(true) // undo consumed the event
  })

  it('routes Cmd-Shift-Z → redoes', () => {
    view = mountWithEdit()
    cleanup = installUndoRouter(() => view)
    pressKey({ key: 'z', meta: true }) // 'hello'
    expect(view.state.doc.toString()).toBe('hello')
    const prevented = pressKey({ key: 'z', meta: true, shift: true }) // redo → 'hello!'
    expect(view.state.doc.toString()).toBe('hello!')
    expect(prevented).toBe(true)
  })

  it('does NOT route when focus is in an <input> (it owns its own undo)', () => {
    view = mountWithEdit()
    cleanup = installUndoRouter(() => view)
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    const prevented = pressKey({ key: 'z', meta: true })
    expect(view.state.doc.toString()).toBe('hello!') // untouched
    expect(prevented).toBe(false)
    input.remove()
  })

  // NOTE: the contentEditable focus guard (editor focused → CM's own keymap owns undo,
  // so the router must bail to avoid a double-undo) is NOT covered here — jsdom doesn't
  // compute el.isContentEditable, so it can only be verified in the real .app.

  it('ignores non-undo keys and modifier-less z', () => {
    view = mountWithEdit()
    cleanup = installUndoRouter(() => view)
    expect(pressKey({ key: 'z' })).toBe(false) // no meta/ctrl
    expect(pressKey({ key: 'a', meta: true })).toBe(false) // not z
    expect(view.state.doc.toString()).toBe('hello!')
  })

  it('is safe when getView() returns null (no mounted editor)', () => {
    cleanup = installUndoRouter(() => null)
    expect(() => pressKey({ key: 'z', meta: true })).not.toThrow()
    expect(pressKey({ key: 'z', meta: true })).toBe(false)
  })

  it('cleanup removes the listener → later Cmd-Z no longer routes', () => {
    view = mountWithEdit()
    const remove = installUndoRouter(() => view)
    remove()
    const prevented = pressKey({ key: 'z', meta: true })
    expect(view.state.doc.toString()).toBe('hello!') // never reached the view
    expect(prevented).toBe(false)
    cleanup = null // already removed
  })
})
