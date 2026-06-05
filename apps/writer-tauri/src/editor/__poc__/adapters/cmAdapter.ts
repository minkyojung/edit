// CodeMirror adapter for the anchor-stability harness. Implements the
// same EditorAdapter contract as pmAdapter, so the IDENTICAL fixtures +
// harness produce a directly comparable number. Headless: it uses only
// @codemirror/state (no DOM/view), mirroring how the PM adapter avoids
// constructing an EditorView.

import { EditorState } from '@codemirror/state'
import type { StateField } from '@codemirror/state'
import type {
  AnchorProbe,
  EditorAdapter,
  Fixture,
  Op,
} from '../anchorStability.types'
import {
  acceptCmAnchor,
  makeAnchorField,
  type CmAnchor,
  type CmEdit,
} from './cmAnchor'

interface CmHandle {
  state: EditorState
  field: StateField<CmAnchor>
  edit: CmEdit
}

interface ChangeSpec {
  from: number
  to?: number
  insert?: string
}

/** Dumb literal change spec for a simulated user edit — plain indexOf,
 * deliberately independent of the anchor logic under test (same stance as
 * the PM adapter). Returns null when `find` is absent (op no-ops). */
function changeForOp(doc: string, op: Op): ChangeSpec | null {
  switch (op.kind) {
    case 'insertText': {
      const i = doc.indexOf(op.find)
      if (i < 0) return null
      return { from: op.where === 'before' ? i : i + op.find.length, insert: op.text }
    }
    case 'deleteText': {
      const i = doc.indexOf(op.find)
      if (i < 0) return null
      return { from: i, to: i + op.find.length }
    }
    case 'replaceText': {
      const i = doc.indexOf(op.find)
      if (i < 0) return null
      return { from: i, to: i + op.find.length, insert: op.text }
    }
    case 'insertBlock': {
      const i = doc.indexOf(op.afterFind)
      if (i < 0) return null
      const le = doc.indexOf('\n', i)
      const cut = le < 0 ? doc.length : le
      return { from: cut, insert: `\n\n${op.markdown}` }
    }
    case 'deleteBlock': {
      const i = doc.indexOf(op.find)
      if (i < 0) return null
      let ls = doc.lastIndexOf('\n', i)
      ls = ls < 0 ? 0 : ls
      let le = doc.indexOf('\n', i)
      le = le < 0 ? doc.length : le
      return { from: ls, to: le }
    }
  }
}

function toCmEdit(edit: Fixture['edit']): CmEdit {
  return {
    kind: edit.kind,
    anchorBefore: edit.anchorBefore,
    before: edit.before,
    after: edit.after,
  }
}

export const cmAdapter: EditorAdapter<CmHandle> = {
  init(fixture: Fixture): CmHandle {
    const edit = toCmEdit(fixture.edit)
    const field = makeAnchorField(edit)
    const state = EditorState.create({
      doc: fixture.initialBody,
      extensions: [field],
    })
    return { state, field, edit }
  },

  applyUserOp(h: CmHandle, op: Op): CmHandle {
    const change = changeForOp(h.state.sliceDoc(), op)
    if (!change) return h
    return { ...h, state: h.state.update({ changes: change }).state }
  },

  probe(h: CmHandle): AnchorProbe {
    const a = h.state.field(h.field)
    const doc = h.state.sliceDoc()
    if (a.status === 'placed') {
      return {
        status: 'placed',
        targetText: a.to !== null ? doc.slice(a.from, a.to) : null,
        textBeforeInsert:
          a.insertAt !== null ? doc.slice(Math.max(0, a.insertAt - 60), a.insertAt) : null,
      }
    }
    return { status: a.status, targetText: null, textBeforeInsert: null }
  },

  accept(h: CmHandle): string {
    return acceptCmAnchor(h.state.sliceDoc(), h.state.field(h.field), h.edit)
  },

  dispose(): void {
    // No shared singletons to reset — CM state is fully local.
  },
}
