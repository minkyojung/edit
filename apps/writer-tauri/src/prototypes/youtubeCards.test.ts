// Headless proof for the YouTube card, mirroring mermaidCards.test.ts. The
// placement + reveal logic (Phase 5: unified onto v2 cursorInRange) and the
// widget's eq() (no-remount identity) are testable on a plain EditorState — no
// browser or real iframe needed. Guards the reveal behavior that was previously
// driven by reveal.activeLines and is now cursorInRange(lineFrom, lineTo).

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import type { DecorationSet, WidgetType } from '@codemirror/view'
import { ensureSyntaxTree } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { youtubeCards } from './youtubeCards'

const URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
const DOC = [
  '# Title',
  '',
  'Some paragraph above.',
  '',
  URL,
  '',
  'Some paragraph below.',
].join('\n')

function stateFor(doc: string, sel?: number): EditorState {
  const state = EditorState.create({
    doc,
    selection: sel === undefined ? undefined : { anchor: sel },
    extensions: [markdown({ extensions: [GFM] }), youtubeCards],
  })
  ensureSyntaxTree(state, doc.length, 5000)
  // Force a rebuild against the now-complete tree (create() ran before parse).
  return state.update({ selection: { anchor: state.selection.main.head } }).state
}

/** The block widget over the URL line, or null when the line is revealed. */
function youtubeWidgetIn(set: DecorationSet): (WidgetType & { videoId: string }) | null {
  let found: (WidgetType & { videoId: string }) | null = null
  set.between(0, 1e9, (_f, _t, deco) => {
    const w = deco.spec.widget
    if (w && 'videoId' in w) {
      found = w as WidgetType & { videoId: string }
      return false
    }
  })
  return found
}

describe('youtube card — placement + reveal + no-remount', () => {
  it('places a block widget for a bare YouTube URL (cursor away)', () => {
    const state = stateFor(DOC, 0) // cursor on line 1, far from the URL
    const w = youtubeWidgetIn(state.field(youtubeCards))
    expect(w).not.toBeNull()
    expect(w!.videoId).toBe('dQw4w9WgXcQ')
  })

  it('cursor ON the URL line reveals raw source (no widget)', () => {
    const urlStart = DOC.indexOf(URL)
    const state = stateFor(DOC, urlStart + 5) // caret inside the URL
    expect(youtubeWidgetIn(state.field(youtubeCards))).toBeNull()
  })

  it('cursor at the very END of the URL line still reveals (edge-inclusive)', () => {
    // cursorInRange is edge-inclusive — a caret at lineTo.to counts as touching.
    const urlEnd = DOC.indexOf(URL) + URL.length
    const state = stateFor(DOC, urlEnd)
    expect(youtubeWidgetIn(state.field(youtubeCards))).toBeNull()
  })

  it('UNRELATED edit keeps an eq() widget → live player NOT torn down', () => {
    const before = stateFor(DOC, 0)
    const wBefore = youtubeWidgetIn(before.field(youtubeCards))!
    const at = before.doc.line(3).from // edit the paragraph above
    const after = before.update({ changes: { from: at, insert: 'XYZ ' } }).state
    const wAfter = youtubeWidgetIn(after.field(youtubeCards))!
    expect(wBefore.eq(wAfter)).toBe(true)
  })
})
