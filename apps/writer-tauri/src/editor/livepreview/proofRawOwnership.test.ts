// Characterization tests for the raw-range OWNERSHIP contract — the seam Phase 2
// changes. `proofRawRanges.ts` claims "Every block/inline renderer reads
// `inProofRawRange()` and skips nodes inside these ranges". That claim is false
// today, in two distinct ways, and each one silently breaks the AI review flow:
//
//   B2  The guard tests whether a node is CONTAINED in a raw range, so a proposal
//       covering only PART of a table leaves the table fully rendered as a block
//       widget — built from text that now includes the proposal. The red/green
//       marks and the accept/reject ButtonsWidget land inside that block replace
//       and are therefore invisible: the proposal can be neither accepted nor
//       rejected.
//   B3  `cards/youtubeCards.ts` and `cards/mermaidCards.ts` never call the guard
//       at all, so a proposed YouTube URL or mermaid fence renders as a live
//       player/diagram instead of a diff.
//
// The failing cases are written with `it.fails`, which asserts they fail TODAY.
// When Phase 2 replaces the containment test with a range-overlap gate, vitest
// will report "expected test to fail" and force these to be flipped to `it`.

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { proofRawRangeProvider, type RawRange } from '@/editor/proofRawRanges'
import { blocksV2 } from './blocks'
import { youtubeCards } from '@/editor/cards/youtubeCards'
import { mermaidCards } from '@/editor/cards/mermaidCards'

const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |'
const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
const MERMAID = '```mermaid\ngraph TD\nA-->B\n```'

function mount(doc: string, raw: RawRange[], extra: unknown[]) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length }, // caret out of the way of reveal gating
      extensions: [
        markdown({ extensions: [GFM] }),
        proofRawRangeProvider.of(() => raw),
        ...(extra as never[]),
      ],
    }),
  })
}

const tableIn = (v: EditorView) => v.contentDOM.querySelector('.cm-table-widget, table')

describe('B2 — a proposal overlapping PART of a table', () => {
  it.fails('leaves the table raw so the accept/reject buttons stay reachable', () => {
    const doc = `intro\n\n${TABLE}\n`
    const tableFrom = doc.indexOf('|')
    // Proposal covers the table's 2nd and 3rd rows only — it starts inside the
    // table, so the table node is NOT contained in it and the guard misses.
    const secondRow = doc.indexOf('\n', tableFrom) + 1
    const view = mount(doc, [{ from: secondRow, to: doc.length - 1 }], [blocksV2])
    try {
      expect(tableIn(view)).toBeNull()
    } finally {
      view.destroy()
    }
  })

  // T0.2b — the inverse. Phase 2 widens the gate from containment to overlap,
  // which is strictly MORE inclusive, so this pins the far edge: a proposal that
  // merely sits next to a table must not suppress it.
  it('a proposal ADJACENT to a table (no overlap) leaves the table rendered', () => {
    const doc = `intro\n\n${TABLE}\n`
    const view = mount(doc, [{ from: 0, to: 5 }], [blocksV2]) // "intro" only
    expect(tableIn(view)).not.toBeNull()
    view.destroy()
  })
})

describe('B3 — cards ignore the raw-range contract entirely', () => {
  it.fails('a proposed YouTube URL shows as a diff, not a player', () => {
    const doc = `intro\n\n${YT}\n`
    const from = doc.indexOf('https')
    const view = mount(doc, [{ from, to: from + YT.length }], [youtubeCards])
    try {
      expect(view.contentDOM.querySelector('.cm-youtube-card')).toBeNull()
    } finally {
      view.destroy()
    }
  })

  it.fails('a proposed mermaid fence shows as a diff, not a diagram', () => {
    const doc = `intro\n\n${MERMAID}\n`
    const from = doc.indexOf('```')
    const view = mount(doc, [{ from, to: from + MERMAID.length }], [mermaidCards])
    try {
      expect(view.contentDOM.querySelector('.cm-mermaid-card')).toBeNull()
    } finally {
      view.destroy()
    }
  })
})
