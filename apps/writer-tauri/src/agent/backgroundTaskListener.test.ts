// Unit tests for the app-level background-task listener — the consumer side of
// the persistent-query path that the sidecar e2e harness (scripts/verify-
// persistent.mjs) can't reach. We mock ONLY the Tauri event boundary (so we can
// drive `claude:task` / `claude:event` / `claude:done` synthetically) and the
// disk layer; everything else runs for real — the real backgroundTasks store,
// the real streamParser, and the real threadsStore.appendTurn — so a wrong
// field or a parser mismatch in the turn-building path is caught here rather
// than only in the running app.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ThreadMeta } from '@/chat/types'
import type { ChatEvent, DoneEvent, ErrorEvent, TaskEvent } from '@/agent/chat/types'

// ── Tauri event boundary: capture each listener callback by event name so tests
// can fire payloads at them. `listen(name, cb)` returns an unlisten. ──────────
type AnyCb = (e: { payload: unknown }) => void
const listeners = new Map<string, AnyCb[]>()
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, cb: AnyCb) => {
    const arr = listeners.get(name) ?? []
    arr.push(cb)
    listeners.set(name, arr)
    return () => {
      const cur = listeners.get(name) ?? []
      listeners.set(
        name,
        cur.filter((c) => c !== cb),
      )
    }
  }),
}))

// Disk layer + threadsStore side-deps (same stubs threadsStore.test uses).
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

import { mountBackgroundTaskListener } from './backgroundTaskListener'
import { useBackgroundTasks } from '@/stores/backgroundTasks'
import { useThreadsStore } from '@/state/threadsStore'

const THREAD = 'thread-1'
const TASK = 'task-abc'

function fire(name: string, payload: unknown) {
  for (const cb of listeners.get(name) ?? []) cb({ payload })
}
function seedThread(id = THREAD) {
  const m: ThreadMeta = { id, title: '', createdAt: 1, updatedAt: 1, archived: false }
  useThreadsStore.setState({ threads: { [id]: m }, turns: {}, draftIds: new Set() })
}
// A minimal SDK text-stream that the real parser turns into one text part.
function textStream(runId: string, threadId: string, text: string): ChatEvent[] {
  const mk = (event: unknown): ChatEvent => ({ runId, threadId, background: true, event } as ChatEvent)
  return [
    mk({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }),
    mk({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } }),
    mk({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
  ]
}
const flush = () => new Promise((r) => setTimeout(r, 0))

let unlisten: () => void
beforeEach(async () => {
  listeners.clear()
  useBackgroundTasks.setState({ byThread: {} })
  seedThread()
  vi.clearAllMocks()
  unlisten = await mountBackgroundTaskListener()
})

describe('backgroundTaskListener — claude:task → store', () => {
  it('records a task_started then reflects its completion + output', () => {
    fire('claude:task', {
      threadId: THREAD, kind: 'started', taskId: TASK, subagentType: 'researcher', description: 'Research',
    } satisfies TaskEvent)
    let t = useBackgroundTasks.getState().byThread[THREAD]?.[TASK]
    expect(t?.status).toBe('running')
    expect(t?.subagentType).toBe('researcher')

    fire('claude:task', {
      threadId: THREAD, kind: 'notification', taskId: TASK, status: 'completed',
      summary: '3 books found', outputFile: '/tmp/out.md',
    } satisfies TaskEvent)
    t = useBackgroundTasks.getState().byThread[THREAD]?.[TASK]
    expect(t?.status).toBe('completed')
    expect(t?.resultSummary).toBe('3 books found')
    expect(t?.outputFile).toBe('/tmp/out.md')
  })

  it('is order-independent: a notification before started still upserts', () => {
    fire('claude:task', { threadId: THREAD, kind: 'notification', taskId: TASK, status: 'completed', summary: 'done' } satisfies TaskEvent)
    expect(useBackgroundTasks.getState().byThread[THREAD]?.[TASK]?.status).toBe('completed')
  })

  it('ignores events for a thread not in threadsStore (headless-session guard)', () => {
    fire('claude:task', { threadId: 'unknown-thread', kind: 'started', taskId: 'x' } satisfies TaskEvent)
    expect(useBackgroundTasks.getState().byThread['unknown-thread']).toBeUndefined()
  })
})

describe('backgroundTaskListener — P2 autonomous completion turn', () => {
  it('streams a background turn and appends it as a standalone assistant turn', async () => {
    const runId = 'bg-run-1'
    for (const ev of textStream(runId, THREAD, 'Research done — 3 books.')) fire('claude:event', ev)
    fire('claude:done', { runId, threadId: THREAD, background: true, stopReason: 'end_turn' } satisfies DoneEvent)
    await flush()

    const turns = useThreadsStore.getState().turns[THREAD] ?? []
    expect(turns).toHaveLength(1)
    const turn = turns[0]
    expect(turn.role).toBe('assistant')
    expect(turn.content).toBe('Research done — 3 books.')
    expect(turn.status).toBe('done')
    expect(turn.parts?.some((p) => p.type === 'text')).toBe(true)
  })

  it('does not append an empty background turn (a wake with no content)', async () => {
    fire('claude:done', { runId: 'bg-empty', threadId: THREAD, background: true, stopReason: null } satisfies DoneEvent)
    await flush()
    expect(useThreadsStore.getState().turns[THREAD] ?? []).toHaveLength(0)
  })

  it('drops the in-flight turn on a background error (no error bubble)', async () => {
    const runId = 'bg-run-2'
    for (const ev of textStream(runId, THREAD, 'partial')) fire('claude:event', ev)
    fire('claude:error', { runId, threadId: THREAD, background: true, code: 'EXEC', message: 'boom' } satisfies ErrorEvent)
    // A done afterwards must not resurrect the dropped turn.
    fire('claude:done', { runId, threadId: THREAD, background: true, stopReason: null } satisfies DoneEvent)
    await flush()
    expect(useThreadsStore.getState().turns[THREAD] ?? []).toHaveLength(0)
  })

  it('ignores non-background events (those belong to the turn layer, not here)', async () => {
    const runId = 'fg-run'
    // Same stream shape but WITHOUT background:true → the listener must skip it.
    const fgStart: ChatEvent = { runId, threadId: THREAD, event: { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } } } as ChatEvent
    fire('claude:event', fgStart)
    fire('claude:done', { runId, threadId: THREAD, stopReason: 'end_turn' } satisfies DoneEvent)
    await flush()
    expect(useThreadsStore.getState().turns[THREAD] ?? []).toHaveLength(0)
  })
})

describe('backgroundTaskListener — teardown', () => {
  it('unlisten removes all registered callbacks', () => {
    expect((listeners.get('claude:task') ?? []).length).toBe(1)
    unlisten()
    expect((listeners.get('claude:task') ?? []).length).toBe(0)
    expect((listeners.get('claude:event') ?? []).length).toBe(0)
    expect((listeners.get('claude:done') ?? []).length).toBe(0)
  })
})
