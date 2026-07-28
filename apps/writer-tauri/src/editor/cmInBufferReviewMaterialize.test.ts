// The reconciler's INSERT step, driven the way production drives it: a change is
// pushed into the store and the editor's subscription materializes it.
//
// Every other test in this suite seeds `matField` directly via `_setMat`, which skips
// `reconcile` entirely — so none of them could see that materialization was throwing.
// `planAdditional` returns mats in POST-insertion coordinates, but they were dispatched
// with `addMat`, whose contract is post-DECISION coordinates that the field expands
// OUTWARD through the transaction's own changes. Mapping a green range that already
// sits past the end of the pre-change document threw
// `RangeError: Position N is out of range for changeset of length M`, the exception
// escaped `reconcile`, and no proposal ever reached the buffer: the chat panel showed
// a review card while the editor stayed blank. It hit every replace and add proposal.

import { describe, expect, it, beforeEach } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { cmInBufferReview, savedBodyOf } from './cmInBufferReview'
import { usePendingChangesStore, type PendingChange } from '@/state/pendingChangesStore'

const SLUG = 'inbox/Note'

function pendingChange(over: Partial<PendingChange> = {}): PendingChange {
  return {
    id: 'c1',
    source: 'chat',
    pageSlug: SLUG,
    groupId: 'g1',
    createdAt: Date.now(),
    status: 'pending',
    edits: [{ id: 'e1', kind: 'replace', anchorBefore: '', before: 'hello', after: 'howdy' }],
    context: {} as never,
    ...over,
  } as PendingChange
}

function mount(doc: string, slug = SLUG) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [markdown({ extensions: [GFM] }), cmInBufferReview(slug)],
    }),
  })
}

/** The reconciler defers its first pass to rAF and reacts to the store in a
 *  subscription, so let both settle. */
const settle = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))

describe('reconcile INSERT — store push materializes into the buffer', () => {
  beforeEach(() => usePendingChangesStore.setState({ byId: {} } as never))

  it('inserts the proposal text', async () => {
    const view = mount('hello')
    await settle()
    usePendingChangesStore.getState().push(pendingChange())
    await settle()
    expect(view.state.doc.toString()).toContain('howdy')
    view.destroy()
  })

  it('keeps the saved body free of the proposal (disk holds accepted text only)', async () => {
    const view = mount('hello')
    await settle()
    usePendingChangesStore.getState().push(pendingChange())
    await settle()
    // The green is in the buffer but must never reach disk while pending — this is
    // the invariant a mis-mapped mat would silently break.
    expect(savedBodyOf(view.state)).toBe('hello')
    view.destroy()
  })

  it('materializes a pure ADD (append) too', async () => {
    const view = mount('intro')
    await settle()
    usePendingChangesStore.getState().push(
      pendingChange({
        id: 'c2',
        edits: [{ id: 'e1', kind: 'add', anchorBefore: '', after: '\n\nappended' }],
      } as Partial<PendingChange>),
    )
    await settle()
    expect(view.state.doc.toString()).toContain('appended')
    expect(savedBodyOf(view.state)).toBe('intro')
    view.destroy()
  })

  it('ignores a change targeting a different note', async () => {
    const view = mount('hello')
    await settle()
    usePendingChangesStore.getState().push(pendingChange({ pageSlug: 'inbox/Other' }))
    await settle()
    expect(view.state.doc.toString()).toBe('hello')
    view.destroy()
  })

  it('materializes a proposal that was already pending when the editor mounted', async () => {
    usePendingChangesStore.getState().push(pendingChange())
    const view = mount('hello')
    await settle()
    expect(view.state.doc.toString()).toContain('howdy')
    view.destroy()
  })
})
