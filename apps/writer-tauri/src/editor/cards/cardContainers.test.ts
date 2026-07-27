// Cards inside containers (blockquote, list).
//
// Both cards render as a BLOCK replace, which CM requires to span whole lines. So
// whatever sits between the line start and the construct is hidden along with it,
// and that cut both ways:
//
//   B5  A YouTube URL or mermaid fence inside a blockquote produced a replace
//       starting at column 0, swallowing the `>` — quote a video and the quote
//       itself vanished.
//   B6  `fenceInfo` matched the fence with a `^`-anchored regex against the LINE
//       text, so an indented fence (one inside a list item) never matched and
//       returned the whole "```mermaid". Never equal to 'mermaid' → a diagram in a
//       list silently never rendered, while the rebuild gate still fired on every
//       keystroke in that fence.
//
// The rule now: leading WHITESPACE in front of the construct is fine (that is what
// nesting in a list looks like); anything non-blank means a container owns those
// columns, so the construct stays raw.

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { youtubeCards } from './youtubeCards'
import { mermaidCards } from './mermaidCards'
import { livePreviewV2 } from '@/editor/livepreview/livePreview'

const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

function mount(doc: string, extra: unknown[]) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: 0 }, // caret on line 0, away from every card below
      extensions: [markdown({ extensions: [GFM] }), ...(extra as never[])],
    }),
  })
}

const q = (v: EditorView, s: string) => v.contentDOM.querySelector(s)

describe('B5 — a card inside a blockquote must not eat the `>`', () => {
  it('a quoted YouTube URL stays raw and the blockquote survives', () => {
    const view = mount(`intro\n\n> ${YT}\n`, [livePreviewV2, youtubeCards])
    expect(q(view, '.cm-youtube-card'), 'must not render as a player').toBeNull()
    expect(q(view, '.cm-blockquote'), 'the quote must still render').not.toBeNull()
    view.destroy()
  })

  it('a quoted mermaid fence stays raw and the blockquote survives', () => {
    const view = mount('intro\n\n> ```mermaid\n> graph TD\n> A-->B\n> ```\n', [livePreviewV2, mermaidCards])
    expect(q(view, '.cm-mermaid-card')).toBeNull()
    expect(q(view, '.cm-blockquote')).not.toBeNull()
    view.destroy()
  })

  it('the same URL at the top level DOES render (the guard is not blanket)', () => {
    const view = mount(`intro\n\n${YT}\n`, [livePreviewV2, youtubeCards])
    expect(q(view, '.cm-youtube-card')).not.toBeNull()
    view.destroy()
  })
})

describe('B6 — an indented mermaid fence', () => {
  it('renders inside a list item', () => {
    const view = mount('- item\n\n  ```mermaid\n  graph TD\n  A-->B\n  ```\n', [mermaidCards])
    expect(q(view, '.cm-mermaid-card'), 'an indented fence must render').not.toBeNull()
    view.destroy()
  })

  it('an indented fence with a NON-mermaid info string still does not render', () => {
    const view = mount('- item\n\n  ```ts\n  const a = 1\n  ```\n', [mermaidCards])
    expect(q(view, '.cm-mermaid-card')).toBeNull()
    view.destroy()
  })
})
