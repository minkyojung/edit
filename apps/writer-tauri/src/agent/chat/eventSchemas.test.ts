import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseChatEvent,
  parseDoneEvent,
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
