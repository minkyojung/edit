// Regression proof for audit E2: blocks.ts's touchesBlocks scanned only the FIRST line
// of a change span (lineAt(fromB)), so a multi-line paste whose image/`<video>` line
// wasn't line 1 didn't trigger a rebuild — the embed stayed raw markdown until the caret
// wandered onto its line. youtubeCards/mermaidCards already scan the whole span; blocks
// was the straggler. Uses a real mounted view (like the youtube/mermaid gating tests) so
// the parse + decoration render round-trips through the DOM.

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { blocksV2 } from './blocks'

function mountView(doc: string) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [markdown({ extensions: [GFM] }), blocksV2],
    }),
  })
}

describe('blocks — multi-line paste rebuild (E2)', () => {
  it('renders an image that lands on a NON-first line of a multi-line insertion', () => {
    const view = mountView('start\n\nend')
    expect(view.contentDOM.querySelector('.cm-img')).toBeNull()
    // Append a 3-line block at the END (caret stays on line 0, far away). The image is
    // the SECOND line of the inserted span, so the old first-line-only scan missed it.
    const block = 'intro para\n![alt](https://example.com/pic.png)\noutro para'
    view.dispatch({ changes: { from: view.state.doc.length, insert: '\n\n' + block } })
    expect(view.contentDOM.querySelector('.cm-img')).not.toBeNull()
    view.destroy()
  })
})
