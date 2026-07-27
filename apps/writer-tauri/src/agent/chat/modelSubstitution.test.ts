// Detecting a silent model substitution.
//
// Asking for a model the CLI no longer serves does NOT fail — it returns a
// successful turn produced by a different model (verified against the live SDK:
// requesting claude-opus-4-1-20250805 was answered by claude-opus-4-8, with
// is_error false). So the picker would keep claiming a model that never answers
// and nothing would ever say otherwise. The only evidence is `message.model`,
// the standard Anthropic response field, which these tests pin.

import { describe, expect, it, vi } from 'vitest'
import { createStreamParser } from './streamParser'
import type { MessagePart, NoticePart } from '@/chat/types'
import type { ChatEvent } from './types'

/** A main-thread assistant message that reports which model produced it. */
const assistantFrom = (model: string): ChatEvent['event'] =>
  ({
    type: 'assistant',
    parent_tool_use_id: null,
    uuid: 'u1',
    message: { model, content: [] },
  }) as unknown as ChatEvent['event']

function collect(requestedModel: string | undefined, events: ChatEvent['event'][]) {
  const parts: MessagePart[] = []
  const onModelSubstituted = vi.fn()
  const parser = createStreamParser({
    onPart: (p) => parts.push(p),
    requestedModel,
    onModelSubstituted,
  })
  for (const ev of events) parser.handleEvent(ev)
  const notices = parts.filter((p): p is NoticePart => p.type === 'notice')
  return { notices, onModelSubstituted }
}

describe('model substitution', () => {
  it('says nothing when the model that answered is the one we asked for', () => {
    const { notices, onModelSubstituted } = collect('claude-opus-4-8', [
      assistantFrom('claude-opus-4-8'),
    ])
    expect(notices).toHaveLength(0)
    expect(onModelSubstituted).not.toHaveBeenCalled()
  })

  it('surfaces a notice naming both models when a substitute answered', () => {
    const { notices, onModelSubstituted } = collect('claude-opus-4-1-20250805', [
      assistantFrom('claude-opus-4-8'),
    ])
    expect(notices).toHaveLength(1)
    expect(notices[0].kind).toBe('model-unavailable')
    expect(notices[0].requestedModel).toBe('claude-opus-4-1-20250805')
    expect(notices[0].fallbackModel).toBe('claude-opus-4-8')
    expect(onModelSubstituted).toHaveBeenCalledWith('claude-opus-4-8')
  })

  // The model is echoed on every assistant message; a long turn would otherwise
  // stack identical rows down the transcript.
  it('notices at most once per run', () => {
    const { notices, onModelSubstituted } = collect('claude-opus-4-1-20250805', [
      assistantFrom('claude-opus-4-8'),
      assistantFrom('claude-opus-4-8'),
      assistantFrom('claude-opus-4-8'),
    ])
    expect(notices).toHaveLength(1)
    expect(onModelSubstituted).toHaveBeenCalledTimes(1)
  })

  // The catalog spells some models with a release date where the app sends the
  // bare id; that is the SAME model, not a substitution.
  it('treats a dated spelling of the same model as no substitution', () => {
    const { notices } = collect('claude-haiku-4-5', [
      assistantFrom('claude-haiku-4-5-20251001'),
    ])
    expect(notices).toHaveLength(0)
  })

  it('stays quiet when the caller did not say what it asked for', () => {
    const { notices } = collect(undefined, [assistantFrom('claude-opus-4-8')])
    expect(notices).toHaveLength(0)
  })

  // Subagents legitimately run on their own model — that isn't a substitution
  // of the user's choice.
  it('ignores subagent messages', () => {
    const sub = {
      type: 'assistant',
      parent_tool_use_id: 'toolu_1',
      uuid: 'u2',
      message: { model: 'claude-haiku-4-5', content: [] },
    } as unknown as ChatEvent['event']
    const { notices } = collect('claude-opus-4-8', [sub])
    expect(notices.filter((n) => n.kind === 'model-unavailable')).toHaveLength(0)
  })
})
