// What Enter does in the composer, including mid-answer.
//
// Before this, a send while an answer was streaming was DROPPED: PromptInput's
// canSubmit carried `!isStreaming`, so submit() returned early, and ChatPanel's
// handleSend had a second `chatStatus === 'streaming'` guard behind it. Nothing
// was lost (the draft survived, since submit() bailed before clearing it) but
// nothing happened either — you had to wait for the answer and retype the
// impulse.
//
// The sidecar was ready the whole time: `#dispatchTurn` queues turns and runs
// them strictly one at a time, FIFO. verify-turn-queue.mjs measures that a
// second chat sent mid-answer is accepted and runs as its own turn afterwards.
// This file pins the composer half — the rule for whether Enter acts at all.
//
// Asserting on the exported predicate rather than a rendered keydown is
// deliberate: there is no render-interaction harness in this package (component
// tests here use renderToStaticMarkup), so a test that restated the condition
// would be asserting against its own copy of it.

import { describe, expect, it } from 'vitest'
import { submitIntent } from './PromptInput'

const state = (over: Partial<Parameters<typeof submitIntent>[0]> = {}) => ({
  disabled: false,
  isStreaming: false,
  hasContent: true,
  valid: true,
  ...over,
})

describe('submitIntent', () => {
  it('sends when idle', () => {
    expect(submitIntent(state())).toBe('send')
  })

  // THE regression this file exists for. 'send' or null here both reproduce the
  // old behaviour — the panel would either double-fire or, as before, do nothing.
  it('QUEUES rather than refusing while an answer is streaming', () => {
    expect(submitIntent(state({ isStreaming: true }))).toBe('queue')
  })

  it('refuses an empty composer, streaming or not', () => {
    expect(submitIntent(state({ hasContent: false }))).toBeNull()
    expect(submitIntent(state({ hasContent: false, isStreaming: true }))).toBeNull()
  })

  it('refuses text the validator rejected, streaming or not', () => {
    expect(submitIntent(state({ valid: false }))).toBeNull()
    expect(submitIntent(state({ valid: false, isStreaming: true }))).toBeNull()
  })

  // `disabled` is no vault / no account. Queueing must not become a way around
  // it: those turns have nowhere to run.
  it('refuses when the composer is disabled, streaming or not', () => {
    expect(submitIntent(state({ disabled: true }))).toBeNull()
    expect(submitIntent(state({ disabled: true, isStreaming: true }))).toBeNull()
  })
})
