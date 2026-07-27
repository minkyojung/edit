// The raw-range OWNERSHIP contract: a pending AI proposal lives as real buffer
// text, and no renderer may decorate over it — otherwise the proposal reads as
// committed content, or worse, disappears inside a block replace.
//
// `proofRawRanges.ts` used to claim "Every block/inline renderer reads
// `inProofRawRange()`". The claim was false in two ways, each of which silently
// broke the AI review flow:
//
//   B2  The guard tested a single point (`node.from`), so a proposal covering
//       only PART of a table left the table rendered as a block widget built from
//       text that included the proposal. The red/green marks and the accept/reject
//       ButtonsWidget landed inside that replace and were therefore invisible:
//       the proposal could be neither accepted nor rejected.
//   B3  `cards/youtubeCards.ts` and `cards/mermaidCards.ts` never called the guard
//       at all, so a proposed YouTube URL or mermaid fence rendered as a live
//       player/diagram instead of a diff.
//
// Both are fixed now: the guard classifies a span as none/partial/inside instead
// of testing a single point, and the cards consult it before replacing. These
// tests were written first with `it.fails` (asserting they failed against the
// point-test version) and flipped once the gate landed.

import { describe, expect, it } from 'vitest'
import { EditorState, StateEffect, StateField } from '@codemirror/state'
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
  it('leaves the table raw so the accept/reject buttons stay reachable', () => {
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
  it('a proposed YouTube URL shows as a diff, not a player', () => {
    const doc = `intro\n\n${YT}\n`
    const from = doc.indexOf('https')
    const view = mount(doc, [{ from, to: from + YT.length }], [youtubeCards])
    try {
      expect(view.contentDOM.querySelector('.cm-youtube-card')).toBeNull()
    } finally {
      view.destroy()
    }
  })

  it('a proposed mermaid fence shows as a diff, not a diagram', () => {
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

describe('proposals that end without a doc change', () => {
  // Rejecting a proposal is dispatched as an EFFECT-ONLY transaction. The block
  // renderers keep a position-mapped decoration set and only re-walk the tree when
  // a gate fires — doc change, caret move, parse progress. A raw-range change is
  // none of those, so gating a card on raw ranges without also gating its REBUILD
  // on them would leave the card suppressed indefinitely.
  const clearProposal = StateEffect.define<null>()

  /** Stands in for cmInBufferReview: holds raw ranges in a field, cleared by an
   *  effect-only transaction, and publishes them through the shared facet. */
  function proposalField(initial: RawRange[]) {
    const field = StateField.define<RawRange[]>({
      create: () => initial,
      update: (v, tr) => (tr.effects.some((e) => e.is(clearProposal)) ? [] : v),
      provide: (f) => proofRawRangeProvider.of((state) => state.field(f)),
    })
    return field
  }

  it('the card renders again once the proposal is cleared', () => {
    const doc = `intro\n\n${YT}\n`
    const from = doc.indexOf('https')
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: { anchor: 0 },
        extensions: [
          markdown({ extensions: [GFM] }),
          proposalField([{ from, to: from + YT.length }]),
          youtubeCards,
        ],
      }),
    })
    expect(view.contentDOM.querySelector('.cm-youtube-card')).toBeNull()
    // No doc change, no selection change, no parse progress — only the effect.
    view.dispatch({ effects: clearProposal.of(null) })
    expect(view.contentDOM.querySelector('.cm-youtube-card')).not.toBeNull()
    view.destroy()
  })
})
