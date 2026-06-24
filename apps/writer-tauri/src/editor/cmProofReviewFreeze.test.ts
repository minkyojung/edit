// Stage 1 — the old (red) text of a pending suggestion is read-only. A user
// edit touching that span is dropped; edits elsewhere and programmatic accepts
// pass through.
import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { _anchoredField, _setAnchored, _freezeOldText } from './cmProofReview'

type Edit = Parameters<typeof _setAnchored.of>[0][number]
const replaceEdit = (from: number, to: number): Edit => ({
  changeId: 'c1',
  editId: 'c1:0',
  from,
  to,
  after: 'X',
  kind: 'replace',
})

function seed(doc: string, edits: Edit[]) {
  let state = EditorState.create({ doc, extensions: [_anchoredField, _freezeOldText] })
  state = state.update({ effects: _setAnchored.of(edits) }).state
  return state
}

describe('freezeOldText — pending old text is read-only', () => {
  it('blocks a user DELETE inside the old span', () => {
    const s = seed('AAA BBB', [replaceEdit(0, 3)]) // protect "AAA"
    const tr = s.update({ changes: { from: 1, to: 2 }, userEvent: 'delete.backward' })
    expect(tr.state.doc.toString()).toBe('AAA BBB') // unchanged
  })

  it('blocks a user INSERT inside the old span', () => {
    const s = seed('AAA BBB', [replaceEdit(0, 3)])
    const tr = s.update({ changes: { from: 2, insert: 'z' }, userEvent: 'input.type' })
    expect(tr.state.doc.toString()).toBe('AAA BBB')
  })

  it('ALLOWS a user edit elsewhere', () => {
    const s = seed('AAA BBB', [replaceEdit(0, 3)])
    const tr = s.update({ changes: { from: 5, insert: 'z' }, userEvent: 'input.type' })
    expect(tr.state.doc.toString()).toBe('AAA BzBB')
  })

  it('ALLOWS programmatic apply into the span (accept path — no userEvent)', () => {
    const s = seed('AAA BBB', [replaceEdit(0, 3)])
    const tr = s.update({ changes: { from: 0, to: 3, insert: 'NEW' } })
    expect(tr.state.doc.toString()).toBe('NEW BBB')
  })

  it('does NOT protect an "add" (pure insertion, no old text)', () => {
    const addEdit: Edit = { changeId: 'c2', editId: 'c2:0', from: 4, to: 4, after: 'Z', kind: 'add' }
    const s = seed('AAA BBB', [addEdit])
    const tr = s.update({ changes: { from: 4, insert: 'q' }, userEvent: 'input.type' })
    expect(tr.state.doc.toString()).toBe('AAA qBBB')
  })

  it('no pending changes → no protection (normal editing)', () => {
    const s = seed('AAA BBB', [])
    const tr = s.update({ changes: { from: 1, to: 2 }, userEvent: 'delete.backward' })
    expect(tr.state.doc.toString()).toBe('AA BBB')
  })
})
