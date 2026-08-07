// Deleting a thread that is still answering brought it back on next launch.
//
// `removeThread` awaited `deleteThreadFiles` BEFORE dropping the thread from
// the store. `appendTurn` guards on `get().threads[id]` — which is still there
// for the whole length of that disk write — so a turn committing inside the
// window sailed past the guard and re-wrote the meta and turns files that had
// just been deleted. Next hydrate found them and the "deleted" conversation
// reappeared, holding a partial answer.
//
// Today the window is ~332ms wide because a cancelled turn commits only after
// the sidecar's CANCELLED round-trips. Settling Stop locally closes that gap to
// a microtask, which turns an occasional resurrection into a reliable one — so
// the order is fixed first, on its own.
//
// The guard is the fix: make it true. Drop from the store first, then touch
// disk, and `appendTurn`'s existing early return covers the window for free.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const disk = vi.hoisted(() => ({
  /** Every file op in order, so a write landing after a delete is visible. */
  log: [] as string[],
  /** Resolves the in-flight delete, to hold the race window open. */
  releaseDelete: null as null | (() => void),
}))

vi.mock('@/lib/threadFiles', () => ({
  appendThreadTurn: vi.fn(async (id: string) => {
    disk.log.push(`appendTurn:${id}`)
  }),
  appendThreadTurns: vi.fn(async () => {}),
  deleteThreadFiles: vi.fn(async (id: string) => {
    disk.log.push(`delete:${id}`)
    // Hold the delete open so a commit can race it, the way a slow vault does.
    await new Promise<void>((r) => {
      disk.releaseDelete = r
    })
  }),
  listThreadIds: vi.fn(async () => []),
  readThreadMeta: vi.fn(async () => null),
  readThreadTurns: vi.fn(async () => []),
  rewriteThreadTurns: vi.fn(async () => {}),
  writeThreadMeta: vi.fn(async (m: { id: string }) => {
    disk.log.push(`writeMeta:${m.id}`)
  }),
}))

import { useThreadsStore } from '@/state/threadsStore'
import type { ChatTurn } from '@/chat/types'

const ID = 'thread-under-test'
const turn = (): ChatTurn =>
  ({ id: 't1', role: 'assistant', content: 'partial answer', status: 'stopped' }) as ChatTurn

beforeEach(() => {
  disk.log.length = 0
  disk.releaseDelete = null
  vi.clearAllMocks()
  useThreadsStore.setState({
    threads: { [ID]: { id: ID, title: 'Doomed', createdAt: 0, updatedAt: 0 } },
    turns: { [ID]: [] },
    draftIds: new Set<string>(),
  } as never)
})

describe('removeThread drops the thread before touching disk', () => {
  it('a turn committing during the delete cannot re-create the files', async () => {
    const removing = useThreadsStore.getState().removeThread(ID)
    // The delete is in flight. This is the window a cancelled turn commits in.
    await useThreadsStore.getState().appendTurn(ID, turn())
    disk.releaseDelete?.()
    await removing

    // The bug: `appendTurn:` / `writeMeta:` appearing after `delete:`.
    const deleteAt = disk.log.indexOf(`delete:${ID}`)
    const writesAfterDelete = disk.log
      .slice(deleteAt + 1)
      .filter((e) => e.startsWith('appendTurn:') || e.startsWith('writeMeta:'))
    expect(writesAfterDelete, `disk ops were: ${disk.log.join(' → ')}`).toEqual([])
  })

  it('and the thread is gone from the store the moment removal starts', async () => {
    const removing = useThreadsStore.getState().removeThread(ID)
    // Synchronously after the call, before the disk write resolves — this is
    // what makes appendTurn's `if (!get().threads[id]) return` load-bearing.
    expect(useThreadsStore.getState().threads[ID]).toBeUndefined()
    disk.releaseDelete?.()
    await removing
  })

  it('still deletes the files', async () => {
    const removing = useThreadsStore.getState().removeThread(ID)
    disk.releaseDelete?.()
    await removing
    expect(disk.log).toContain(`delete:${ID}`)
  })
})
