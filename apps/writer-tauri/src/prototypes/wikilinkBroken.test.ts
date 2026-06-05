// Headless proof for broken-wikilink styling: a known title renders as
// cm-wikilink, an unknown one as cm-wikilink-broken.

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { buildDecorations } from './livePreview'
import { isKnownNote } from './wikilinkComplete'

function classesFor(doc: string): string[] {
  const state = EditorState.create({ doc, extensions: [markdown({ extensions: [GFM] })] })
  ensureSyntaxTree(state, doc.length, 5000)
  const { decos } = buildDecorations(state, [{ from: 0, to: state.doc.length }], new Set())
  return decos
    .map((r) => r.value.spec.class as string | undefined)
    .filter((c): c is string => !!c && c.startsWith('cm-wikilink'))
}

describe('broken wikilink styling', () => {
  it('isKnownNote: known vs unknown', () => {
    expect(isKnownNote('Roadmap')).toBe(true)
    expect(isKnownNote('Ghost Note')).toBe(false)
  })

  it('known title → cm-wikilink, unknown → cm-wikilink-broken', () => {
    const classes = classesFor('See [[Roadmap]] and [[Ghost Note]].')
    expect(classes).toContain('cm-wikilink')
    expect(classes).toContain('cm-wikilink-broken')
  })
})
