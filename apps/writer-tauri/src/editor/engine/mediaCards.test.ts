// Headless proof for the media (video/audio) card — same risk as the chart:
// does the widget survive CodeMirror's per-edit churn WITHOUT remounting (so
// the <video>/<audio> element keeps its playback position)? Lives entirely in
// eq() + placement/reveal logic → testable on a plain EditorState.

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'
import { ensureSyntaxTree } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { mediaField, MediaWidget } from './mediaCards'

const DOC = [
  '# Media',
  '',
  'Paragraph above.',
  '',
  '<video src="https://example.com/a.mp4" controls></video>',
  '',
  '<audio src="https://example.com/a.mp3" title="Clip" controls></audio>',
  '',
  'Paragraph below.',
].join('\n')

function stateFor(doc: string, sel = 0): EditorState {
  const state = EditorState.create({
    doc,
    selection: { anchor: sel },
    extensions: [markdown({ extensions: [GFM] }), mediaField],
  })
  ensureSyntaxTree(state, doc.length, 5000)
  return state.update({ selection: { anchor: sel } }).state
}

function widgetsIn(set: DecorationSet): MediaWidget[] {
  const found: MediaWidget[] = []
  set.between(0, 1e9, (_f, _t, deco) => {
    const w = deco.spec.widget
    if (w instanceof MediaWidget) found.push(w)
  })
  return found
}

describe('media card — widget lifecycle (no-remount) proof', () => {
  it('places block widgets for <video> and <audio> (cursor away)', () => {
    const ws = widgetsIn(stateFor(DOC, 0).field(mediaField))
    expect(ws.map((w) => w.kind).sort()).toEqual(['audio', 'video'])
    const video = ws.find((w) => w.kind === 'video')!
    expect(video.src).toBe('https://example.com/a.mp4')
    const audio = ws.find((w) => w.kind === 'audio')!
    expect(audio.title).toBe('Clip')
  })

  it('UNRELATED edit keeps eq() widgets → media element NOT torn down (playback survives)', () => {
    const before = stateFor(DOC, 0)
    const vBefore = widgetsIn(before.field(mediaField)).find((w) => w.kind === 'video')!
    const at = before.doc.line(3).from // edit the paragraph above
    const after = before.update({ changes: { from: at, insert: 'XYZ ' } }).state
    const vAfter = widgetsIn(after.field(mediaField)).find((w) => w.kind === 'video')!
    expect(vBefore.eq(vAfter)).toBe(true)
  })

  it('editing the media src yields a non-eq widget', () => {
    const before = stateFor(DOC, 0)
    const vBefore = widgetsIn(before.field(mediaField)).find((w) => w.kind === 'video')!
    const srcPos = DOC.indexOf('a.mp4')
    const after = before.update({ changes: { from: srcPos, insert: 'X' } }).state
    const vAfter = widgetsIn(after.field(mediaField)).find((w) => w.kind === 'video')!
    expect(vBefore.eq(vAfter)).toBe(false)
  })

  it('cursor on a media line reveals raw source (no widget there)', () => {
    const videoLineStart = DOC.indexOf('<video')
    const ws = widgetsIn(stateFor(DOC, videoLineStart + 3).field(mediaField))
    // video revealed (raw source); audio still rendered
    expect(ws.map((w) => w.kind)).toEqual(['audio'])
  })
})
