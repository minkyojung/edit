// The raw-range guard is CONTAINMENT, not a point test on `node.from`.
//
// Both decoration walks (`livePreview`'s tree.iterate and `blocks`'s) always enter
// the root `Document` node first, and `Document.from` is 0. The guard used to ask
// `inProofRawRange(state, node.from)`, so a pending AI proposal touching position 0
// matched at the root and `return false` aborted the ENTIRE walk — the whole
// document lost its live-preview and block decorations for as long as the proposal
// was open. Reachable from `proposalPlan.ts`, which computes a red range starting
// at 0 whenever the first line is the one being changed.
//
// These tests fail against the point-test version.

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { proofRawRangeProvider, type RawRange } from '@/editor/proofRawRanges'
import { _buildDecos } from './livePreview'
import { blocksV2 } from './blocks'

/** A state whose pending-proposal raw ranges are exactly `raw`. */
function stateWith(doc: string, raw: RawRange[], extra: unknown[] = []) {
  return EditorState.create({
    doc,
    selection: { anchor: doc.length }, // caret parked at the end: nothing is reveal-gated
    extensions: [
      markdown({ extensions: [GFM] }),
      proofRawRangeProvider.of(() => raw),
      ...(extra as never[]),
    ],
  })
}

function decosFor(doc: string, raw: RawRange[]) {
  const state = stateWith(doc, raw)
  return _buildDecos(state, [{ from: 0, to: state.doc.length }])
}

describe('livePreview raw-range guard', () => {
  it('a proposal at position 0 does NOT blank the rest of the document', () => {
    // `# Title` is the proposal; the heading + list below it are committed content
    // and must still render.
    const doc = '# Title\n\n## Later heading\n\n- item'
    const withProposal = decosFor(doc, [{ from: 0, to: 7 }])
    const clean = decosFor(doc, [])

    expect(withProposal.length).toBeGreaterThan(0)
    // Everything after the proposal decorates exactly as it would with no proposal.
    const after = (rs: ReturnType<typeof decosFor>) => rs.filter((r) => r.from >= 9).length
    expect(after(withProposal)).toBe(after(clean))
  })

  it('still leaves a CONTAINED construct raw', () => {
    const doc = 'plain\n\n## Proposed heading\n'
    const headingFrom = doc.indexOf('##')
    const headingTo = doc.indexOf('\n', headingFrom)
    const withProposal = decosFor(doc, [{ from: headingFrom, to: headingTo }])
    const clean = decosFor(doc, [])

    // No decoration lands inside the proposal…
    expect(withProposal.filter((r) => r.from >= headingFrom && r.from < headingTo)).toHaveLength(0)
    // …but the clean run does decorate that heading, so the guard really fired.
    expect(clean.filter((r) => r.from >= headingFrom && r.from < headingTo).length).toBeGreaterThan(0)
  })

  it('a node starting exactly at a range end is outside it (half-open)', () => {
    const doc = 'ab\n\n## Heading\n'
    const headingFrom = doc.indexOf('##')
    // Range ends right where the heading begins — the heading must still render.
    const decos = decosFor(doc, [{ from: 0, to: headingFrom }])
    expect(decos.filter((r) => r.from >= headingFrom).length).toBeGreaterThan(0)
  })
})

describe('blocks raw-range guard', () => {
  const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |'

  function mount(doc: string, raw: RawRange[]) {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    return new EditorView({ parent, state: stateWith(doc, raw, [blocksV2]) })
  }

  it('a proposal at position 0 does NOT stop a table further down from rendering', () => {
    const doc = `intro\n\n${TABLE}\n`
    const view = mount(doc, [{ from: 0, to: 5 }]) // "intro" is the proposal
    expect(view.contentDOM.querySelector('.cm-table-widget, table')).not.toBeNull()
    view.destroy()
  })

  it('a table CONTAINED in a proposal stays raw', () => {
    const doc = `intro\n\n${TABLE}\n`
    const tableFrom = doc.indexOf('|')
    const view = mount(doc, [{ from: tableFrom, to: tableFrom + TABLE.length }])
    expect(view.contentDOM.querySelector('.cm-table-widget, table')).toBeNull()
    view.destroy()
  })
})
