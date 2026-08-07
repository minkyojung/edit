import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseChatEvent,
  parseDoneEvent,
  parseEditPendingEvent,
  parseErrorEvent,
  parseTaskEvent,
} from './eventSchemas'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('event envelope validation', () => {
  it('accepts well-formed payloads and returns them unchanged', () => {
    const chat = { runId: 'r1', threadId: 't1', event: { type: 'assistant' } }
    expect(parseChatEvent(chat)).toBe(chat)

    const done = { runId: 'r1', stopReason: 'end_turn' }
    expect(parseDoneEvent(done)).toBe(done)

    const err = { runId: 'r1', code: 'AUTH', message: 'nope' }
    expect(parseErrorEvent(err)).toBe(err)

    const task = { threadId: 't1', kind: 'started', taskId: 'x' }
    expect(parseTaskEvent(task)).toBe(task)
  })

  it('passes through unknown extra fields (SDK blob / forward-compat)', () => {
    // The sidecar/SDK may add fields we do not model; they must survive, not
    // cause a rejection.
    const chat = { runId: 'r1', event: { type: 'stream_event', brandNew: 42 }, future: true }
    expect(parseChatEvent(chat)).toBe(chat)
  })

  it('drops (and logs) a payload missing its routing key instead of returning it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(parseChatEvent({ event: { type: 'assistant' } })).toBeNull() // no runId
    expect(parseChatEvent({ runId: 'r1' })).toBeNull() // no event object
    expect(parseDoneEvent({ stopReason: 'end_turn' })).toBeNull() // no runId
    expect(parseErrorEvent({ code: 'AUTH' })).toBeNull() // no runId
    expect(parseTaskEvent({ kind: 'started' })).toBeNull() // no threadId

    expect(parseChatEvent(null)).toBeNull()
    expect(parseChatEvent(undefined)).toBeNull()

    expect(warn).toHaveBeenCalled()
  })

  it('rejects wrong-typed routing keys', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseChatEvent({ runId: 42, event: {} })).toBeNull()
    expect(parseTaskEvent({ threadId: 42 })).toBeNull()
  })
})

// edit-pending is the one channel that requires more than its routing key. The
// reasoning is at `editPendingEnvelope` in eventSchemas.ts; what it buys is
// asserted here, and end-to-end in editPending.characterization.test.ts.
describe('edit-pending envelope', () => {
  const good = {
    runId: 'r1',
    pendingId: 'p1',
    toolName: 'Write',
    input: { file_path: '/v/a.md', content: 'x' },
  }

  it('accepts a well-formed proposal unchanged', () => {
    expect(parseEditPendingEvent(good)).toBe(good)
  })

  it('passes through tool-specific fields it does not model', () => {
    const multi = { ...good, toolName: 'MultiEdit', input: { file_path: '/v/a.md', edits: [] } }
    expect(parseEditPendingEvent(multi)).toBe(multi)
  })

  it('drops a proposal with no pendingId — the ack would reach nobody', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { pendingId: _omitted, ...noId } = good
    expect(parseEditPendingEvent(noId)).toBeNull()
  })

  it('drops a proposal with no input — the mapper has nothing to read', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { input: _omitted, ...noInput } = good
    expect(parseEditPendingEvent(noInput)).toBeNull()
    expect(parseEditPendingEvent({ ...good, input: 'not an object' })).toBeNull()
  })

  it('drops a proposal with no runId — it cannot be routed to a run', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runId: _omitted, ...noRun } = good
    expect(parseEditPendingEvent(noRun)).toBeNull()
  })
})
