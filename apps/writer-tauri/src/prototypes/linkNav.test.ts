// Headless proof for general-link open resolution.

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { linkAtPos } from './linkNav'

const state = (doc: string) => EditorState.create({ doc })

describe('linkAtPos', () => {
  const doc = 'see [normal link](https://example.com) here'
  const s = state(doc)

  it('returns the url when pos is inside the link', () => {
    expect(linkAtPos(s, doc.indexOf('normal') + 1)).toBe('https://example.com')
  })

  it('returns null in plain text', () => {
    expect(linkAtPos(s, doc.indexOf('here') + 1)).toBeNull()
  })

  it('skips note: scheme (wikilink, handled elsewhere)', () => {
    const d = '[Sera](note:abc)'
    expect(linkAtPos(state(d), 3)).toBeNull()
  })

  it('returns null on a bare wikilink line', () => {
    const d = 'a [[Roadmap]] b'
    expect(linkAtPos(state(d), 6)).toBeNull()
  })
})
