// Headless proof for wikilink click resolution: a click position maps to the
// `[[Title]]` under it (or null). The DOM click wiring is the thin shell.

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { wikilinkAtPos } from './wikilinkNav'

function stateOf(doc: string): EditorState {
  return EditorState.create({ doc })
}

describe('wikilinkAtPos', () => {
  const doc = 'see [[Roadmap]] and [[Design Spec]] now'
  const state = stateOf(doc)

  it('returns the title when pos is inside the link', () => {
    expect(wikilinkAtPos(state, doc.indexOf('Roadmap') + 2)).toBe('Roadmap')
  })

  it('picks the correct link among several on the line', () => {
    expect(wikilinkAtPos(state, doc.indexOf('Design Spec') + 1)).toBe('Design Spec')
  })

  it('returns null in plain text outside any link', () => {
    expect(wikilinkAtPos(state, doc.indexOf('and') + 1)).toBeNull()
  })

  it('returns null when the line has no wikilink', () => {
    expect(wikilinkAtPos(stateOf('just plain text'), 4)).toBeNull()
  })
})
