// Headless proof for the media drop/paste pure helpers (classification +
// inserted markdown). The drop/paste DOM wiring is the thin shell.

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { classifyMedia, markdownForMedia, mediaDropPaste } from './mediaDrop'

describe('classifyMedia', () => {
  it('routes by MIME prefix', () => {
    expect(classifyMedia({ type: 'image/png' })).toBe('image')
    expect(classifyMedia({ type: 'video/mp4' })).toBe('video')
    expect(classifyMedia({ type: 'audio/mpeg' })).toBe('audio')
  })
  it('ignores non-media', () => {
    expect(classifyMedia({ type: 'text/plain' })).toBeNull()
    expect(classifyMedia({ type: '' })).toBeNull()
  })
})

describe('markdownForMedia (matches card detection forms)', () => {
  it('image → ![]()', () => {
    expect(markdownForMedia('image', 'u', 'cat.png')).toBe('![cat.png](u)')
  })
  it('video → <video>', () => {
    expect(markdownForMedia('video', 'u', 'clip.mp4')).toBe('<video src="u" controls></video>')
  })
  it('audio → <audio> with title', () => {
    expect(markdownForMedia('audio', 'u', 'song.mp3')).toBe(
      '<audio src="u" title="song.mp3" controls></audio>',
    )
  })
})

// Audit C1 (wiring): the imported card must land at the MAPPED drop point, not the stale
// offset captured before the async import. Drive the paste handler with a fake file + a
// controllable import, make an edit ABOVE the drop point while the import is in flight,
// then resolve it and assert the card follows the (moved) target line.
describe('mediaDropPaste — inserts at the mapped drop point (C1)', () => {
  const flush = async () => {
    await Promise.resolve()
    await Promise.resolve()
  }
  it('an edit above the drop point during import does not misplace the card', async () => {
    let resolveImport!: (url: string) => void
    const importFile = () => new Promise<string>((r) => { resolveImport = r })
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: 'AAAA\nBBBB\nCCCC\nDDDD', extensions: [mediaDropPaste(importFile)] }),
    })
    view.dispatch({ selection: { anchor: 7 } }) // caret in the BBBB line

    const file = new File(['x'], 'p.png', { type: 'image/png' })
    const ev = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
    ev.clipboardData = { files: [file] }
    view.contentDOM.dispatchEvent(ev)

    view.dispatch({ changes: { from: 0, insert: 'XX\n' } }) // edit ABOVE the drop point
    resolveImport('vault/p.png')
    await flush()

    const doc = view.state.doc.toString()
    expect(doc).toContain('BBBB\n\n![') // glued after the moved BBBB line — mapped
    expect(doc).not.toContain('AAAA\n\n![') // not the stale offset
    view.destroy()
  })
})
