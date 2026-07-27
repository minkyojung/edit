// The reconciler's remaining paths, driven end-to-end through the real store.
//
// Every assertion checks `savedBodyOf` alongside the visible document, because that
// is the value the 500 ms flush writes to disk. A mis-tracked range is invisible on
// screen and only shows up as a corrupted file — which is how the REFRESH bug below
// went unnoticed.

import { describe, expect, it, beforeAll, beforeEach } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { cmInBufferReview, savedBodyOf } from './cmInBufferReview'
import { usePendingChangesStore, type PendingChange } from '@/state/pendingChangesStore'

const SLUG = 'inbox/Note'

function pc(id: string, before: string, after: string): PendingChange {
  return {
    id,
    source: 'chat',
    pageSlug: SLUG,
    groupId: 'g1',
    createdAt: Date.now(),
    status: 'pending',
    edits: [{ id: `e-${id}`, kind: 'replace', anchorBefore: '', before, after }],
    context: {} as never,
  } as unknown as PendingChange
}

function mount(doc: string) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [history(), markdown({ extensions: [GFM] }), cmInBufferReview(SLUG)],
    }),
  })
}
const settle = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))

// jsdom has no layout; CM's measure phase throws once rAF runs. Nothing here asserts
// on geometry — see cmInBufferReviewFlip.test.ts for the same shim.
beforeAll(() => {
  const p = Range.prototype as unknown as Record<string, unknown>
  p.getClientRects ??= () => Object.assign([], { item: () => null })
  p.getBoundingClientRect ??= () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 })
})

describe('reconcile lifecycle', () => {
  beforeEach(() => usePendingChangesStore.setState({ byId: {} } as never))

  it('REFRESH keeps the original text when a proposal grows mid-turn', async () => {
    // The agent editing one note twice in a turn re-pushes the SAME change id with
    // grown content (mergeEditIntoStagedBody), which is what triggers REFRESH.
    // Un-materializing used to delete the RED as well as the green — but the red is
    // the document's own text, nothing re-inserts it, and re-planning against a
    // document that lost its original finds no anchor. The note came out EMPTY.
    const view = mount('hello')
    await settle()
    usePendingChangesStore.getState().push(pc('c1', 'hello', 'howdy'))
    await settle()
    expect(savedBodyOf(view.state)).toBe('hello')

    usePendingChangesStore.getState().push(pc('c1', 'hello', 'howdy there'))
    await settle()
    expect(view.state.doc.toString(), 'original must survive').toContain('hello')
    expect(view.state.doc.toString(), 'grown proposal shows').toContain('howdy there')
    expect(savedBodyOf(view.state), 'disk still holds only the original').toBe('hello')

    usePendingChangesStore.getState().accept('c1')
    await settle()
    expect(savedBodyOf(view.state)).toBe('howdy there')
    view.destroy()
  })

  it('two proposals coexist and decide independently', async () => {
    const view = mount('alpha\n\nbeta')
    await settle()
    usePendingChangesStore.getState().push(pc('c1', 'alpha', 'ALPHA'))
    await settle()
    usePendingChangesStore.getState().push(pc('c2', 'beta', 'BETA'))
    await settle()
    expect(savedBodyOf(view.state)).toBe('alpha\n\nbeta')

    usePendingChangesStore.getState().accept('c1')
    await settle()
    // c1 committed, c2 still staged — its green must stay out of the saved body.
    expect(savedBodyOf(view.state)).toBe('ALPHA\n\nbeta')
    expect(view.state.doc.toString()).toContain('BETA')
    view.destroy()
  })

  it('user edits around a pending proposal keep the ranges aligned', async () => {
    const view = mount('hello world')
    await settle()
    usePendingChangesStore.getState().push(pc('c1', 'hello', 'howdy'))
    await settle()

    view.dispatch({ changes: { from: view.state.doc.length, insert: '!' }, userEvent: 'input.type' })
    await settle()
    expect(savedBodyOf(view.state)).toBe('hello world!')

    view.dispatch({ changes: { from: 0, insert: 'X' }, userEvent: 'input.type' })
    await settle()
    expect(savedBodyOf(view.state)).toBe('Xhello world!')

    usePendingChangesStore.getState().accept('c1')
    await settle()
    expect(savedBodyOf(view.state)).toBe('Xhowdy world!')
    view.destroy()
  })

  it('a proposal still pending when the note is reopened re-materializes once', async () => {
    const view = mount('hello')
    await settle()
    usePendingChangesStore.getState().push(pc('c1', 'hello', 'howdy'))
    await settle()
    const checkpoint = savedBodyOf(view.state) // what the unmount checkpoint mirrors
    view.destroy()
    expect(checkpoint).toBe('hello')

    const reopened = mount(checkpoint)
    await settle()
    expect(reopened.state.doc.toString()).toContain('howdy')
    expect(savedBodyOf(reopened.state), 'not doubled on remount').toBe('hello')
    reopened.destroy()
  })
})
