// What a pending proposal must survive — and what it must not outlive.
//
// Two gaps found by walking the paths nothing had exercised. Both were unreachable
// while materialization was broken, so neither had ever been possible to hit; both
// became reachable the moment proposals started appearing in the buffer.

import { describe, expect, it, beforeAll, beforeEach } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, undo } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { cmInBufferReview, savedBodyOf, isMaterialized, _matField } from './cmInBufferReview'
import { usePendingChangesStore, type PendingChange } from '@/state/pendingChangesStore'

const SLUG = 'inbox/Note'

const pendingChange = (): PendingChange =>
  ({
    id: 'c1',
    source: 'chat',
    pageSlug: SLUG,
    groupId: 'g1',
    createdAt: Date.now(),
    status: 'pending',
    edits: [{ id: 'e1', kind: 'replace', anchorBefore: '', before: 'hello', after: 'howdy' }],
    context: {} as never,
  }) as unknown as PendingChange

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

beforeAll(() => {
  const p = Range.prototype as unknown as Record<string, unknown>
  p.getClientRects ??= () => Object.assign([], { item: () => null })
  p.getBoundingClientRect ??= () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 })
})

async function staged(doc = 'hello') {
  const view = mount(doc)
  await settle()
  usePendingChangesStore.getState().push(pendingChange())
  await settle()
  return view
}

const buttons = (v: EditorView) => v.contentDOM.querySelectorAll('.cm-proof-review').length
const marks = (v: EditorView) => v.contentDOM.querySelectorAll('.cm-proof-old,.cm-proof-new').length

describe('a proposal left with no text is discarded', () => {
  beforeEach(() => usePendingChangesStore.setState({ byId: {} } as never))

  it('wiping red and green together removes the review widget', async () => {
    // An edit spanning both sides clamps all four positions into the deletion. The
    // empty mat used to linger: ✓/✕ still drawn with no diff beside them, offering to
    // accept or reject something invisible, and isMaterialized still true so the
    // applier believed the editor owned a proposal that was gone.
    const view = await staged()
    expect(buttons(view)).toBe(1)

    view.dispatch({ changes: { from: 0, to: view.state.doc.length } })
    await settle()

    expect(view.state.field(_matField)).toHaveLength(0)
    expect(buttons(view)).toBe(0)
    expect(marks(view)).toBe(0)
    expect(isMaterialized(view.state, 'c1')).toBe(false)
    view.destroy()
  })

  it('keeps a proposal that is empty on only ONE side', async () => {
    // A pure append has no red and a deletion proposal has no green; both are normal
    // and must not be swept up by the same rule.
    const view = mount('intro')
    await settle()
    usePendingChangesStore.getState().push({
      ...pendingChange(),
      edits: [{ id: 'e1', kind: 'add', anchorBefore: '', after: '\n\nappended' }],
    } as unknown as PendingChange)
    await settle()

    expect(view.state.field(_matField).length).toBeGreaterThan(0)
    expect(buttons(view)).toBe(1)
    view.destroy()
  })
})

describe('the original text is protected from user edits', () => {
  beforeEach(() => usePendingChangesStore.setState({ byId: {} } as never))

  const editsRed = async (userEvent: string | undefined) => {
    const view = await staged()
    view.dispatch({ changes: { from: 1, to: 4 }, userEvent })
    const survived = view.state.doc.toString().startsWith('hello')
    view.destroy()
    return survived
  }

  it('refuses typing and deleting inside it', async () => {
    expect(await editsRed('input.type')).toBe(true)
    expect(await editsRed('delete.backward')).toBe(true)
  })

  it('refuses a drag-and-drop move out of it', async () => {
    // CodeMirror reports drag-move as `move.drop`, not as a delete, so the filter
    // missed it: dragging a selection overlapping the original carried it away while
    // typing into the very same text was refused.
    expect(await editsRed('move.drop')).toBe(true)
  })

  it('still lets programmatic edits through', async () => {
    // Accept, reject and the reconciler all rewrite red deliberately and dispatch
    // without a userEvent. Freezing those would break the review entirely.
    expect(await editsRed(undefined)).toBe(false)
  })
})

describe('a proposal survives edits elsewhere', () => {
  beforeEach(() => usePendingChangesStore.setState({ byId: {} } as never))

  it('undoing an earlier user edit keeps the ranges aligned', async () => {
    const view = mount('hello')
    await settle()
    view.dispatch({ changes: { from: 5, insert: ' world' }, userEvent: 'input.type' })
    await settle()
    usePendingChangesStore.getState().push({
      ...pendingChange(),
      edits: [{ id: 'e1', kind: 'replace', anchorBefore: '', before: 'hello world', after: 'howdy' }],
    } as unknown as PendingChange)
    await settle()
    expect(savedBodyOf(view.state)).toBe('hello world')

    undo(view)
    await settle()
    expect(savedBodyOf(view.state)).toBe('hello')
    expect(view.state.doc.toString()).toContain('howdy')
    view.destroy()
  })
})
