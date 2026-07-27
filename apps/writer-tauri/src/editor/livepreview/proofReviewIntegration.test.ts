// End-to-end for the proposal/renderer contract, driven through the REAL review
// extension rather than a stand-in facet provider.
//
// The unit tests next door register their own `proofRawRangeProvider`, which
// proves the gate logic but not the wiring: that `cmInBufferReview` publishes the
// ranges the renderers read, and — the part that actually broke — that the
// accept/reject buttons survive. The buttons are an inline widget placed at the
// end of a proposal (`ButtonsWidget`); if a block renderer replaces the lines they
// sit on, CM never renders them at all, so the proposal becomes unacceptable and
// unrejectable with no error anywhere.
//
// One case per real-app checklist item.

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { cmInBufferReview, _setMat, _dropChange } from '@/editor/cmInBufferReview'
import { livePreviewV2 } from './livePreview'
import { blocksV2 } from './blocks'
import { youtubeCards } from '@/editor/cards/youtubeCards'
import { mermaidCards } from '@/editor/cards/mermaidCards'

const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
const MERMAID = '```mermaid\ngraph TD\nA-->B\n```'
const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |'

type Hunk = { redFrom: number; redTo: number; greenFrom: number; greenTo: number; kind: 'replace' }

/** Mount with the real review extension and materialize one proposal. */
function withProposal(doc: string, hunks: Hunk[], renderers: unknown[], anchor = 0) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        markdown({ extensions: [GFM] }),
        cmInBufferReview('test-note'),
        ...(renderers as never[]),
      ],
    }),
  })
  view.dispatch({ effects: _setMat.of([{ changeId: 'c1', hunks }]) })
  return view
}

const q = (v: EditorView, sel: string) => v.contentDOM.querySelector(sel)

/** The proposal is visible AS a proposal: struck-through old text and the ✓/✕ pair. */
function expectReviewable(view: EditorView) {
  expect(q(view, '.cm-proof-old'), 'red (old) text must be marked').not.toBeNull()
  expect(q(view, '.cm-proof-review'), 'accept/reject buttons must render').not.toBeNull()
  expect(view.contentDOM.querySelectorAll('.cm-proof-review button')).toHaveLength(2)
}

describe('checklist 1 — a proposal on the FIRST line', () => {
  it('leaves the rest of the document rendered, and is itself reviewable', () => {
    const doc = `# Old title\n# New title\n\n## Later heading\n\n- item`
    const view = withProposal(
      doc,
      [{ redFrom: 0, redTo: 11, greenFrom: 12, greenTo: 23, kind: 'replace' }],
      [livePreviewV2],
    )
    // Content BELOW the proposal still live-previews (this is what went blank).
    expect(q(view, '.cm-h2'), 'the later heading must still render').not.toBeNull()
    expect(q(view, '.cm-list-marker'), 'the list marker must still render').not.toBeNull()
    expectReviewable(view)
    view.destroy()
  })
})

describe('checklist 1b — the inline layer reacts to a proposal appearing/ending', () => {
  // livePreview is a ViewPlugin, and its rebuild gate watches doc/viewport/
  // selection/focus/parse. Raw ranges are none of those, so a proposal set or
  // dropped by an effect-only transaction left the whole viewport decorated under
  // the previous proposal state. This is the ViewPlugin twin of checklist 4.
  it('a heading goes raw when a proposal covers it, and renders again when it ends', () => {
    const doc = 'intro\n\n## Heading\n'
    const from = doc.indexOf('##')
    const to = doc.indexOf('\n', from)
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: { anchor: 0 },
        extensions: [markdown({ extensions: [GFM] }), cmInBufferReview('test-note'), livePreviewV2],
      }),
    })
    expect(q(view, '.cm-h2'), 'renders as a heading to begin with').not.toBeNull()

    const before = view.state.doc.toString()
    view.dispatch({
      effects: _setMat.of([{ changeId: 'c1', hunks: [{ redFrom: from, redTo: to, greenFrom: to, greenTo: to, kind: 'replace' }] }]),
    })
    expect(view.state.doc.toString(), 'no doc change').toBe(before)
    expect(q(view, '.cm-h2'), 'proposed heading must show raw, not render').toBeNull()

    view.dispatch({ effects: _dropChange.of('c1') })
    expect(q(view, '.cm-h2'), 'renders again once the proposal ends').not.toBeNull()
    view.destroy()
  })
})

describe('checklist 2 — a proposal covering PART of a table', () => {
  it('keeps the table raw so the accept/reject buttons are reachable', () => {
    const doc = `intro\n\n${TABLE}\n`
    const tableFrom = doc.indexOf('|')
    const secondRow = doc.indexOf('\n', tableFrom) + 1 // rows 2-3 only
    const view = withProposal(
      doc,
      [{ redFrom: secondRow, redTo: doc.length - 1, greenFrom: doc.length - 1, greenTo: doc.length - 1, kind: 'replace' }],
      [livePreviewV2, blocksV2],
    )
    expect(q(view, '.cm-table-widget, table'), 'table must NOT be a widget').toBeNull()
    // The real regression: the buttons used to be sealed inside the table's block
    // replace, so they never reached the DOM.
    expectReviewable(view)
    view.destroy()
  })
})

describe('checklist 3 — proposed cards read as diffs', () => {
  it('a proposed YouTube URL does not become a player', () => {
    const doc = `intro\n\n${YT}\n`
    const from = doc.indexOf('https')
    const view = withProposal(
      doc,
      [{ redFrom: from, redTo: from + YT.length, greenFrom: from + YT.length, greenTo: from + YT.length, kind: 'replace' }],
      [youtubeCards],
    )
    expect(q(view, '.cm-youtube-card')).toBeNull()
    expectReviewable(view)
    view.destroy()
  })

  it('a proposed mermaid fence does not become a diagram', () => {
    const doc = `intro\n\n${MERMAID}\n`
    const from = doc.indexOf('```')
    const view = withProposal(
      doc,
      [{ redFrom: from, redTo: from + MERMAID.length, greenFrom: from + MERMAID.length, greenTo: from + MERMAID.length, kind: 'replace' }],
      [mermaidCards],
    )
    expect(q(view, '.cm-mermaid-card')).toBeNull()
    expectReviewable(view)
    view.destroy()
  })
})

describe('checklist 4 — the card returns the moment the proposal ends', () => {
  it('dropping the proposal (effect-only, no doc change) re-renders the card', () => {
    const doc = `intro\n\n${YT}\n`
    const from = doc.indexOf('https')
    const view = withProposal(
      doc,
      [{ redFrom: from, redTo: from + YT.length, greenFrom: from + YT.length, greenTo: from + YT.length, kind: 'replace' }],
      [youtubeCards],
    )
    expect(q(view, '.cm-youtube-card')).toBeNull()
    const before = view.state.doc.toString()
    // `dropChange` is how accept/reject clear a proposal. Nothing else in this
    // transaction: no text edit, no caret move, no parse progress — the three gates
    // the card's StateField uses to decide whether to re-walk the tree.
    view.dispatch({ effects: _dropChange.of('c1') })
    expect(view.state.doc.toString(), 'no doc change').toBe(before)
    expect(q(view, '.cm-youtube-card'), 'card must come back immediately').not.toBeNull()
    expect(q(view, '.cm-proof-review'), 'review buttons must be gone').toBeNull()
    view.destroy()
  })
})
