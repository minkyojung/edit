// Lazy thread materialisation (Claude Code model): a new chat is a DRAFT —
// in memory, no disk file — until its first turn, at which point it
// materialises (meta file written). This locks that behaviour so blank chats
// can't regress to eager on-disk creation (which piled up dead files + ate the
// active-thread budget).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ThreadMeta, ChatTurn } from '@/chat/types'

vi.mock('@/lib/threadFiles', () => ({
  writeThreadMeta: vi.fn(async () => {}),
  appendThreadTurn: vi.fn(async () => {}),
  appendThreadTurns: vi.fn(async () => {}),
  rewriteThreadTurns: vi.fn(async () => {}),
  deleteThreadFiles: vi.fn(async () => {}),
  listThreadIds: vi.fn(async () => []),
  readThreadMeta: vi.fn(async () => null),
  readThreadTurns: vi.fn(async () => []),
}))
vi.mock('@/state/contextUsageStore', () => ({
  useContextUsageStore: { getState: () => ({ set: () => {} }) },
}))
vi.mock('@/state/chatDraftStore', () => ({
  useChatDraftStore: { getState: () => ({ remove: () => {} }) },
}))

import { useThreadsStore } from './threadsStore'
import {
  writeThreadMeta,
  appendThreadTurn,
  deleteThreadFiles,
} from '@/lib/threadFiles'

function meta(id: string): ThreadMeta {
  const now = 1
  return { id, title: '', createdAt: now, updatedAt: now, archived: false }
}
function turn(id: string): ChatTurn {
  return { id, role: 'user', content: 'hi', ts: 1 }
}

beforeEach(() => {
  useThreadsStore.setState({ threads: {}, turns: {}, draftIds: new Set(), hydrated: false })
  vi.clearAllMocks()
})

describe('threadsStore lazy materialisation', () => {
  it('createThread adds a draft without touching disk', async () => {
    await useThreadsStore.getState().createThread(meta('t1'))
    const s = useThreadsStore.getState()
    expect(s.threads.t1).toBeDefined()
    expect(s.turns.t1).toEqual([])
    expect(s.draftIds.has('t1')).toBe(true)
    expect(writeThreadMeta).not.toHaveBeenCalled()
  })

  it('materialize writes the meta file once and clears the draft flag', async () => {
    await useThreadsStore.getState().createThread(meta('t1'))
    await useThreadsStore.getState().materialize('t1')
    expect(writeThreadMeta).toHaveBeenCalledTimes(1)
    expect(useThreadsStore.getState().draftIds.has('t1')).toBe(false)
    // Second call is a no-op.
    await useThreadsStore.getState().materialize('t1')
    expect(writeThreadMeta).toHaveBeenCalledTimes(1)
  })

  it('first appendTurn materialises before writing the turn (meta precedes turns)', async () => {
    await useThreadsStore.getState().createThread(meta('t1'))
    await useThreadsStore.getState().appendTurn('t1', turn('a'))
    expect(writeThreadMeta).toHaveBeenCalledTimes(1)
    expect(appendThreadTurn).toHaveBeenCalledTimes(1)
    // Meta file must be written before the turns file (boot scan keys on meta).
    expect(vi.mocked(writeThreadMeta).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(appendThreadTurn).mock.invocationCallOrder[0],
    )
    expect(useThreadsStore.getState().draftIds.has('t1')).toBe(false)
    expect(useThreadsStore.getState().turns.t1.map((t) => t.id)).toEqual(['a'])
  })

  it('updateMeta on a draft stays in memory; on a materialised thread it writes', async () => {
    await useThreadsStore.getState().createThread(meta('t1'))
    await useThreadsStore.getState().updateMeta('t1', { title: 'draft edit' })
    expect(writeThreadMeta).not.toHaveBeenCalled()
    expect(useThreadsStore.getState().threads.t1.title).toBe('draft edit')

    await useThreadsStore.getState().materialize('t1') // 1 write
    await useThreadsStore.getState().updateMeta('t1', { title: 'after' })
    expect(writeThreadMeta).toHaveBeenCalledTimes(2)
  })

  it('removeThread discards a draft (no-op delete) and clears the draft flag', async () => {
    await useThreadsStore.getState().createThread(meta('t1'))
    await useThreadsStore.getState().removeThread('t1')
    expect(deleteThreadFiles).toHaveBeenCalledWith('t1')
    const s = useThreadsStore.getState()
    expect(s.threads.t1).toBeUndefined()
    expect(s.draftIds.has('t1')).toBe(false)
  })
})
