// R1 caret-jump probe + guard (headless EditorView in jsdom).
//
// FINDING (2026-06-06): the leftward caret jump is NOT reproducible at the state
// level. Simulating the space keystroke faithfully (replaceSelection) keeps the
// caret after the space (head=2) BOTH with and without livePreview — so the
// atomic ranges do not move the caret in the state/transaction layer. The real
// R1 therefore lives in the BROWSER DOM-input / measurement path (contentEditable
// beforeinput → DOMObserver → applyDOMChange, + cursor association against a
// freshly-recomputed atomic set), which jsdom does not run faithfully. ⇒ R1 must
// be reproduced/verified in a real browser; these tests instead (1) GUARD that
// atomic never breaks state-level typing-into-a-list, and (2) characterize the
// deterministic atomic-skip surface that a fix would change.

import { describe, expect, it } from 'vitest'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import {
  defaultKeymap,
  historyKeymap,
  history,
  indentWithTab,
  cursorCharLeft,
} from '@codemirror/commands'
import { markdown, insertNewlineContinueMarkup, deleteMarkupBackward } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { livePreview } from './livePreview'

function mount(doc: string, anchor: number, extra: Extension): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        history(),
        keymap.of([
          { key: 'Enter', run: insertNewlineContinueMarkup },
          { key: 'Backspace', run: deleteMarkupBackward },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.lineWrapping,
        markdown({ extensions: [GFM], addKeymap: false }),
        extra,
      ],
    }),
  })
}

// Caret head after typing a space on `-` (→ `- `), via the faithful "typing"
// path (replaceSelection) — caret should land AFTER the space (offset 2).
function typeSpaceHead(extra: Extension): number {
  const view = mount('-', 1, extra)
  view.dispatch(view.state.replaceSelection(' '))
  const head = view.state.selection.main.head
  view.destroy()
  return head
}

describe('R1 caret-jump probe (headless EditorView)', () => {
  it('attributes the leftward caret jump to livePreview atomicRanges', () => {
    const withLP = typeSpaceHead(livePreview)
    const withoutLP = typeSpaceHead([])
    // eslint-disable-next-line no-console
    console.log('[R1] typing space on `-` → head:  with livePreview =', withLP, ' | without =', withoutLP)
    // The control (no livePreview) must keep the caret after the space.
    expect(withoutLP).toBe(2)
    // If livePreview drags it left, this fails — that IS R1, attributed.
    expect(withLP).toBe(2)
  })

  it('characterizes cursor motion across the atomic `- ` prefix', () => {
    const probe = (extra: Extension) => {
      const view = mount('- x', 2, extra) // caret at content start (after `- `)
      cursorCharLeft(view)
      const head = view.state.selection.main.head
      view.destroy()
      return head
    }
    const withLP = probe(livePreview)
    const withoutLP = probe([])
    // eslint-disable-next-line no-console
    console.log('[R1] cursorCharLeft from 2 on `- x` → with livePreview =', withLP, ' | without =', withoutLP)
    // Documents whatever the atomic prefix does to leftward motion (no fixed
    // expectation yet — this is the deterministic surface a fix would change).
    expect(withLP).toBeGreaterThanOrEqual(0)
    expect(withoutLP).toBe(1)
  })
})
