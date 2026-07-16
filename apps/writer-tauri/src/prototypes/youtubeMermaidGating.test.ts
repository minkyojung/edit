// Regression for the youtube/mermaid rebuild gating (absorbed from the sanaa
// worktree). The fields used to re-walk the whole syntax tree on every keystroke;
// they now keep the position-MAPPED decoration set on unrelated doc changes and
// only rebuild when the change could touch an embed/fence. The risk of that change
// is stale positions — so pin that an embed survives an unrelated edit (mapping
// works) and that a freshly-inserted one renders (the touches* gate fires).

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { youtubeCards } from './youtubeCards'
import { mermaidCards } from './mermaidCards'

const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
const MERMAID = '```mermaid\ngraph TD\nA-->B\n```'

function mountView(doc: string, extra: unknown[]) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [markdown({ extensions: [GFM] }), ...(extra as never[])],
    }),
  })
}

describe('youtube gating', () => {
  it('renders at mount and SURVIVES an unrelated edit (mapped set stays valid)', () => {
    const view = mountView(`intro\n\n${YT}\n\noutro`, [youtubeCards])
    expect(view.contentDOM.querySelector('.cm-youtube-card')).not.toBeNull()
    // Type on line 0 — far from the embed. The gate must keep the mapped set, and
    // the embed must remain rendered (not dropped, not stale).
    view.dispatch({ changes: { from: 0, insert: 'X' } })
    expect(view.contentDOM.querySelector('.cm-youtube-card')).not.toBeNull()
    view.destroy()
  })

  it('renders a URL inserted after mount (touchesYoutube fires on `youtu`)', () => {
    const view = mountView('hello\n\n', [youtubeCards])
    expect(view.contentDOM.querySelector('.cm-youtube-card')).toBeNull()
    view.dispatch({ changes: { from: view.state.doc.length, insert: YT } })
    expect(view.contentDOM.querySelector('.cm-youtube-card')).not.toBeNull()
    view.destroy()
  })
})

describe('mermaid gating', () => {
  it('renders at mount and survives an unrelated edit', () => {
    const view = mountView(`intro\n\n${MERMAID}\n\noutro`, [mermaidCards])
    expect(view.contentDOM.querySelector('.cm-mermaid-card')).not.toBeNull()
    view.dispatch({ changes: { from: 0, insert: 'X' } })
    expect(view.contentDOM.querySelector('.cm-mermaid-card')).not.toBeNull()
    view.destroy()
  })

  it('renders a fence inserted after mount (touchesMermaid fires on the fence)', () => {
    const view = mountView('hello\n\n', [mermaidCards])
    expect(view.contentDOM.querySelector('.cm-mermaid-card')).toBeNull()
    view.dispatch({ changes: { from: view.state.doc.length, insert: MERMAID } })
    expect(view.contentDOM.querySelector('.cm-mermaid-card')).not.toBeNull()
    view.destroy()
  })
})
