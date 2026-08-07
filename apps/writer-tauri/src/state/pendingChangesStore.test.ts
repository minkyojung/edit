// `push` rebuilds the change field-by-field rather than spreading, which is the
// right call — it fixes the lifecycle fields (status, decidedAt, …) rather than
// letting a caller set them. The cost is that a caller-supplied field is
// silently dropped if it isn't listed, and nothing type-checks that: the
// argument type is `Omit<PendingChange, 'status' | …>`, so an optional field is
// legal to pass and legal to ignore.
//
// That is how `createdNewNote` was lost. `toPendingChange` set it, `push` didn't
// copy it, and `pendingChangesApplier`'s `cleanupRejectedNewNote` — 18 lines
// whose only trigger is that flag — could never run. Every rejected "create this
// note" proposal left an empty orphan note behind instead.
//
// The end-to-end consequence is covered in pendingChangesApplier.test.ts; this
// pins it at the layer that actually drops it, so the next person to add a field
// to `push` fails here rather than in a distant listener.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./docsStore/docBody', () => ({ readDocBody: () => '' }))

import { usePendingChangesStore } from './pendingChangesStore'

function push(extra: Record<string, unknown> = {}) {
  return usePendingChangesStore.getState().push({
    id: 'c1',
    source: 'chat',
    pageSlug: 'note',
    groupId: 'g1',
    edits: [{ id: 'e1', kind: 'add', anchorBefore: '', after: 'x' }],
    context: { threadId: 't1' },
    ...extra,
  } as Parameters<ReturnType<typeof usePendingChangesStore.getState>['push']>[0])
}

beforeEach(() => {
  usePendingChangesStore.setState({ byId: {} })
})

describe('push carries the caller-supplied fields it is given', () => {
  it('keeps createdNewNote — the applier cleans up an orphan note by it', () => {
    push({ createdNewNote: true })
    expect(usePendingChangesStore.getState().byId.c1.createdNewNote).toBe(true)
  })

  it('leaves it unset when the caller did not create a note', () => {
    push()
    expect(usePendingChangesStore.getState().byId.c1.createdNewNote).toBeFalsy()
  })

  it('keeps reason — it becomes the commit body', () => {
    push({ reason: '오탈자 고침' })
    expect(usePendingChangesStore.getState().byId.c1.reason).toBe('오탈자 고침')
  })

  it('still owns the lifecycle fields rather than taking them from the caller', () => {
    push({ status: 'accepted', decidedAt: 123 })
    const c = usePendingChangesStore.getState().byId.c1
    expect(c.status).toBe('pending')
    expect(c.decidedAt).toBeNull()
  })
})
