import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { liveSugField, sugState, reanchor, type Persisted, type LiveSug } from './anchorLifecycle'

const DOC = `# Release notes

The anchor holds steady as the doc grows around it.

| Concept | Status |
| :-- | :-- |
| anchor | solid |

A sentence that is the target of a unique edit.
`

const mk = (text: string) =>
  EditorState.create({ doc: text, extensions: [markdown({ extensions: [GFM] }), liveSugField] })

describe('reanchor (reload re-find by quote + structure)', () => {
  const persisted: Persisted[] = [
    { id: 's1', quote: 'anchor', after: 'anchor point', context: 'table cell' }, // ambiguous → context picks
    { id: 's2', quote: 'unique edit', after: 'precise edit', context: 'paragraph' }, // single
    { id: 's3', quote: 'phrase that does not exist', after: 'x', context: 'paragraph' }, // missing
  ]

  it('disambiguates an ambiguous quote by its stored structural context', () => {
    const st = mk(DOC)
    const { live } = reanchor(st, persisted)
    const s1 = live.find((s) => s.id === 's1')!
    expect(s1).toBeTruthy()
    // It anchored to the "anchor" inside the table cell, not the heading/paragraph one.
    expect(st.doc.sliceString(s1.from, s1.to)).toBe('anchor')
    expect(sugState(st, s1)).toBe('alive')
    expect(st.doc.lineAt(s1.from).text).toContain('| anchor | solid |')
  })

  it('anchors a unique quote and abstains on a missing one (unplaced, not misplaced)', () => {
    const { live, unplaced } = reanchor(mk(DOC), persisted)
    expect(live.map((s) => s.id).sort()).toEqual(['s1', 's2'])
    expect(unplaced.map((s) => s.id)).toEqual(['s3'])
  })
})

describe('sugState (live alive/stale/unplaced)', () => {
  it('is alive when the text under the range still equals the quote', () => {
    const st = mk(DOC)
    const i = DOC.indexOf('unique edit')
    const s: LiveSug = { id: 'x', quote: 'unique edit', after: 'precise edit', context: 'paragraph', from: i, to: i + 'unique edit'.length }
    expect(sugState(st, s)).toBe('alive')
  })

  it('is stale when an edit inside changed the quoted text', () => {
    const i = DOC.indexOf('unique edit')
    const st = mk(DOC)
    // Type a char inside the range → the slice no longer equals the quote.
    const tr = st.update({ changes: { from: i + 1, insert: 'X' } })
    const s: LiveSug = { id: 'x', quote: 'unique edit', after: 'precise edit', context: 'paragraph', from: i, to: i + 'unique edit'.length + 1 }
    expect(sugState(tr.state, s)).toBe('stale')
  })
})
