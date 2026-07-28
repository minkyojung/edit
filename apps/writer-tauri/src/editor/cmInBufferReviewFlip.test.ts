// Undoing a decision, driven end-to-end: real store → real reconciler → real history.
//
// Undoing an accept re-inserts the RED text; undoing a reject re-inserts the GREEN.
// The field re-expands the collapsed mat across that insertion, and the two sides need
// OPPOSITE associations depending on which one is coming back. A single pair was used
// for both, so on an accept-undo `greenFrom` landed BEFORE the re-inserted red and green
// covered the whole document. `savedBodyOf` strips green, so the body written to disk
// became EMPTY — undoing an accept silently emptied the note on the next 500 ms flush,
// and rejecting from that state deleted the document text outright.
//
// These assertions are on `savedBodyOf`, not just the visible doc, because that is the
// value the flush writes; a mis-expanded mat is invisible on screen until it is saved.

import { describe, expect, it, beforeAll, beforeEach } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, undo, redo } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { cmInBufferReview, savedBodyOf, isMaterialized } from './cmInBufferReview'
import { usePendingChangesStore, type PendingChange } from '@/state/pendingChangesStore'

const SLUG = 'inbox/Note'
const ORIGINAL = 'hello'
const PROPOSED = 'howdy'

function pendingChange(): PendingChange {
  return {
    id: 'c1',
    source: 'chat',
    pageSlug: SLUG,
    groupId: 'g1',
    createdAt: Date.now(),
    status: 'pending',
    edits: [{ id: 'e1', kind: 'replace', anchorBefore: '', before: ORIGINAL, after: PROPOSED }],
    context: {} as never,
  } as unknown as PendingChange
}

function mount() {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: ORIGINAL,
      selection: { anchor: 0 },
      extensions: [history(), markdown({ extensions: [GFM] }), cmInBufferReview(SLUG)],
    }),
  })
}

const settle = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))

// Letting rAF run also lets CodeMirror's measure phase run, and jsdom implements
// neither `Range.getClientRects` nor layout — CM throws out of the animation frame,
// which vitest reports as an unhandled error even though every assertion passes.
// Nothing here asserts on geometry, so give Range the two methods CM probes for
// rather than leave five errors in the suite output to mask a real one later.
beforeAll(() => {
  const proto = Range.prototype as unknown as Record<string, unknown>
  proto.getClientRects ??= () => Object.assign([], { item: () => null })
  proto.getBoundingClientRect ??= () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 })
})

async function materialized() {
  const view = mount()
  await settle()
  usePendingChangesStore.getState().push(pendingChange())
  await settle()
  return view
}

describe('undoing a decision keeps the saved body correct', () => {
  beforeEach(() => usePendingChangesStore.setState({ byId: {} } as never))

  it('while pending, the saved body is the original', async () => {
    const view = await materialized()
    expect(view.state.doc.toString()).toContain(PROPOSED) // green is in the buffer
    expect(savedBodyOf(view.state)).toBe(ORIGINAL) // …but never on disk
    view.destroy()
  })

  it('undoing an ACCEPT restores the proposal without swallowing the document', async () => {
    const view = await materialized()
    usePendingChangesStore.getState().accept('c1')
    await settle()
    expect(savedBodyOf(view.state)).toBe(PROPOSED)

    undo(view)
    await settle()
    // Back to the pending state: green visible, original saved. `''` here was the bug.
    expect(savedBodyOf(view.state)).toBe(ORIGINAL)
    expect(view.state.doc.toString()).toContain(PROPOSED)
    expect(isMaterialized(view.state, 'c1')).toBe(true)
    view.destroy()
  })

  it('undoing a REJECT restores the proposal', async () => {
    const view = await materialized()
    usePendingChangesStore.getState().reject('c1')
    await settle()
    expect(savedBodyOf(view.state)).toBe(ORIGINAL)

    undo(view)
    await settle()
    expect(savedBodyOf(view.state)).toBe(ORIGINAL)
    expect(view.state.doc.toString()).toContain(PROPOSED)
    view.destroy()
  })

  it('rejecting AFTER undoing an accept does not delete the document', async () => {
    const view = await materialized()
    usePendingChangesStore.getState().accept('c1')
    await settle()
    undo(view)
    await settle()
    usePendingChangesStore.getState().reject('c1')
    await settle()
    // The reject deletes green; the original must survive. It became '' before the fix.
    expect(view.state.doc.toString()).toBe(ORIGINAL)
    expect(savedBodyOf(view.state)).toBe(ORIGINAL)
    view.destroy()
  })

  it('survives repeated accept ↔ undo cycles', async () => {
    const view = await materialized()
    for (let i = 0; i < 3; i++) {
      usePendingChangesStore.getState().accept('c1')
      await settle()
      expect(savedBodyOf(view.state), `accept #${i + 1}`).toBe(PROPOSED)
      undo(view)
      await settle()
      expect(savedBodyOf(view.state), `undo #${i + 1}`).toBe(ORIGINAL)
    }
    view.destroy()
  })

  it('redo re-applies the accept', async () => {
    const view = await materialized()
    usePendingChangesStore.getState().accept('c1')
    await settle()
    undo(view)
    await settle()
    redo(view)
    await settle()
    expect(savedBodyOf(view.state)).toBe(PROPOSED)
    expect(usePendingChangesStore.getState().byId['c1']?.status).toBe('accepted')
    view.destroy()
  })
})
