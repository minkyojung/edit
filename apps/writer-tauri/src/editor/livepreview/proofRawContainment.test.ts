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

describe('decorations are gated at the point of emission', () => {
  // Found in review. The node-level gate can only classify the node's own span, but
  // branches decorate beyond it — the ListMark branch is entered for the marker yet
  // marks `- [ ]` and strikes a completed task's body to end of line. A proposal
  // covering only the body was therefore struck through and muted, which inside a
  // red/green diff reads as "deleted".
  it('a proposal over a task BODY is not struck through', () => {
    const doc = '- [x] done text'
    const bodyFrom = doc.indexOf('done')
    const withProposal = decosFor(doc, [{ from: bodyFrom, to: doc.length }])
    const clean = decosFor(doc, [])
    expect(clean.some((r) => r.value.spec.class === 'cm-task-done'), 'control: normally struck').toBe(true)
    expect(withProposal.some((r) => r.value.spec.class === 'cm-task-done')).toBe(false)
  })

  it('a proposal over a task MARKER does not hide the proposal text', () => {
    // `.cm-task-marker` is visibility:hidden, so marking proposal characters with it
    // would make them invisible.
    const doc = '- [x] done text'
    const decos = decosFor(doc, [{ from: 2, to: doc.length }])
    expect(decos.some((r) => r.value.spec.class?.includes('cm-task-marker'))).toBe(false)
  })

  it('the one-char overshoot on a heading marker is gated too', () => {
    // HeaderMark hides `#` PLUS the trailing space — one char past the node — so a
    // proposal starting at that space is missed by a node-level check. The trailing
    // `tail` keeps the caret off the heading line; on the caret's own line the
    // markers are revealed and nothing is hidden at all, which would make this
    // assertion vacuous.
    const doc = '## Heading\n\ntail'
    const hidesAtZero = (raw: RawRange[]) =>
      decosFor(doc, raw).filter((r) => r.from === 0 && r.value.spec.class === undefined)
    expect(hidesAtZero([]), 'control: `## ` is normally hidden').toHaveLength(1)
    expect(hidesAtZero([{ from: 2, to: 10 }])).toHaveLength(0)
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
