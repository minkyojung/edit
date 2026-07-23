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

  // NOTE: "a reload landing AFTER a user edit still leaves that user edit undoable"
  // is deliberately NOT asserted here — the whole-doc replace maps the stored history
  // entry into a degenerate (empty) change, so undo can't reach it. That's audit item
  // A4 (minimal-diff reload); this test file stays scoped to A1 (non-undoable reload).

  it('carries externalBody(true) AND addToHistory(false) as annotations', () => {
    const state = EditorState.create({ doc: 'x' })
    const tr = state.update(externalReloadSpec(state, 'y'))
    expect(tr.annotation(externalBody)).toBe(true)
    expect(tr.annotation(Transaction.addToHistory)).toBe(false)
  })
})
