// Regression proof for the external-reload data-loss path (audit A1). A vault-watcher
// reload / background rewrite pushed through the docsStore body path must NOT enter the
// undo history: if it did, Cmd-Z would revert the buffer to the pre-reload text, and
// that undo transaction — carrying neither externalBody nor addToHistory — would
// re-dirty the slug and flush the STALE body back over the external edit (silent loss).
// externalReloadSpec must therefore be (a) non-undoable and (b) still tagged externalBody
// so the save listener keeps ignoring it. We mount a REAL EditorView with history() so
// undo() exercises CM's actual history, not a stub.

import { describe, it, expect } from 'vitest'
import { EditorState, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, undo } from '@codemirror/commands'
import { externalReloadSpec, externalBody } from './buildExtensions'

describe('externalReloadSpec', () => {
  it('replaces the whole doc but is NOT undoable', () => {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: 'ORIGINAL', extensions: [history()] }),
    })
    view.dispatch(externalReloadSpec(view.state, 'RELOADED'))
    expect(view.state.doc.toString()).toBe('RELOADED')
    // The reload is not a history entry → nothing to undo, doc stays put.
    expect(undo(view)).toBe(false)
    expect(view.state.doc.toString()).toBe('RELOADED')
    view.destroy()
  })

  it('carries externalBody(true) AND addToHistory(false) as annotations', () => {
    const state = EditorState.create({ doc: 'x' })
    const tr = state.update(externalReloadSpec(state, 'y'))
    expect(tr.annotation(externalBody)).toBe(true)
    expect(tr.annotation(Transaction.addToHistory)).toBe(false)
  })
})

// Audit A4: the reload is a MINIMAL line diff, not a whole-doc replace.
describe('externalReloadSpec — minimal change (A4)', () => {
  it('is a no-op when the incoming body equals the current doc (echo reload)', () => {
    const state = EditorState.create({ doc: 'a\nb\nc' })
    const tr = state.update(externalReloadSpec(state, 'a\nb\nc'))
    expect(tr.docChanged).toBe(false)
  })

  it('touches only the lines that differ, not the whole document', () => {
    const state = EditorState.create({ doc: 'line1\nline2\nline3' })
    const tr = state.update(externalReloadSpec(state, 'LINE1\nline2\nline3'))
    expect(tr.newDoc.toString()).toBe('LINE1\nline2\nline3')
    const touched: { from: number; to: number }[] = []
    tr.changes.iterChangedRanges((fromA, toA) => touched.push({ from: fromA, to: toA }))
    expect(touched).toEqual([{ from: 0, to: 6 }]) // only 'line1\n'; line2/line3 untouched
  })

  it('a user edit on an UNTOUCHED line stays undoable after an external reload elsewhere', () => {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: 'line1\nline2\nline3', extensions: [history()] }),
    })
    // A genuine user edit on the LAST line (undoable).
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'X' }, userEvent: 'input' })
    expect(view.state.doc.toString()).toBe('line1\nline2\nline3X')
    // An external reload changes the FIRST line only.
    view.dispatch(externalReloadSpec(view.state, 'LINE1\nline2\nline3X'))
    expect(view.state.doc.toString()).toBe('LINE1\nline2\nline3X')
    // Cmd-Z now reverts the user's OWN edit (line3) while the reload (line1) stands —
    // the old whole-doc replace mapped this history entry into a degenerate no-op, so
    // the edit was unreachable.
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('LINE1\nline2\nline3')
    view.destroy()
  })
})
