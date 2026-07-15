import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { richClipboardPayload } from './cmRichCopy'

describe('richClipboardPayload', () => {
  it('returns null when the selection is empty', () => {
    const state = EditorState.create({ doc: '## Title\n- a\n- b', selection: { anchor: 3 } })
    expect(richClipboardPayload(state)).toBeNull()
  })

  it('converts the selected markdown to html and keeps the source', () => {
    const doc = '## Title\n- a\n- b'
    const state = EditorState.create({ doc, selection: { anchor: 0, head: doc.length } })
    const payload = richClipboardPayload(state)
    expect(payload).not.toBeNull()
    expect(payload!.md).toBe(doc)
    expect(payload!.html).toContain('<h2>Title</h2>')
    expect(payload!.html).toContain('<li>a</li>')
  })

  it('slices only the selected range, not the whole doc', () => {
    const doc = 'keep\n**bold**\ndrop'
    // select just the "**bold**" line (chars 5..13)
    const state = EditorState.create({ doc, selection: { anchor: 5, head: 13 } })
    const payload = richClipboardPayload(state)
    expect(payload!.md).toBe('**bold**')
    expect(payload!.html).toContain('<strong>bold</strong>')
    expect(payload!.html).not.toContain('keep')
    expect(payload!.html).not.toContain('drop')
  })
})
