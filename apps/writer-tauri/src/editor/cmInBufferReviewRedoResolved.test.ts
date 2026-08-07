// Accept → Cmd-Z → Cmd-Shift-Z inserted the AI's text a second time.
//
// The whole accept path is idempotent because of ONE value. `keep()` computes
// the merged body and hands it to the store as `resolvedResult` specifically so
// the applier's write is `next === current` and does nothing — the reasoning is
// spelled out in the comment above that call.
//
// Redo never runs `keep()`. It re-fires `acceptEffect` through the inverted
// effects, and `acceptUndoWatcher` was the only caller left — passing no
// `resolvedResult`. Meanwhile `reopen` (the undo) had cleared the one the
// original accept stored. So the applier fell past its idempotent branch into
// the per-edit loop and appended `edit.after` to a buffer that already
// contained it.
//
// `add` proposals duplicate silently; `replace` ones fail loudly instead,
// because their `before` anchor is already gone. That asymmetry is why this
// surfaced as "the text is just there twice" rather than as an error.

import { describe, expect, it, beforeAll, beforeEach } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, redo, undo } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { cmInBufferReview } from './cmInBufferReview'
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

beforeEach(() => {
  usePendingChangesStore.setState({ byId: {} } as never)
})

/** Clicks the real ✓ widget — the genuine user path, so `keep()` runs rather
 *  than the test restating what it does. */
function clickKeep(view: EditorView) {
  const btn = view.contentDOM.querySelector('.cm-proof-keep') as HTMLElement | null
  expect(btn, 'the Keep widget must be rendered').not.toBeNull()
  btn!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
}

describe('accept → undo → redo keeps the applier idempotent', () => {
  it('redo re-accepts WITH the merged body, so the applier stays a no-op', async () => {
    const view = mount('hello')
    await settle()
    usePendingChangesStore.getState().push(pendingChange())
    await settle()

    clickKeep(view)
    await settle()
    const accepted = usePendingChangesStore.getState().byId.c1
    expect(accepted.status).toBe('accepted')
    expect(accepted.resolvedResult, 'keep() supplies it').toBeDefined()

    undo(view)
    await settle()
    // The undo deliberately reopens the card, which clears the merged body —
    // the change really is pending again.
    expect(usePendingChangesStore.getState().byId.c1.status).toBe('pending')

    redo(view)
    await settle()

    const after = usePendingChangesStore.getState().byId.c1
    expect(after.status, 'redo re-accepts').toBe('accepted')
    // The bug: this was undefined, so the applier took the per-edit path and
    // wrote the AI text on top of a buffer that already had it.
    expect(
      after.resolvedResult,
      'without this the applier re-applies the edit instead of no-opping',
    ).toBeDefined()
    // And it must be the CURRENT buffer, not a stale snapshot.
    expect(after.resolvedResult).toBe(view.state.doc.toString())

    view.destroy()
  })
})
