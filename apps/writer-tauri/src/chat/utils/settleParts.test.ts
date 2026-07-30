// A stopped or failed answer persisted its tool rows exactly as they were, so a
// tool call whose result never arrived stayed in `input-streaming` /
// `input-available` forever — and `ToolStateMark` renders a spinner for those.
// The turn is written to disk that way, so the spinner comes back on every
// launch, animating a call that ended days ago.
//
// A turn that ended cleanly must NOT be touched: `output-available` there is
// the truth, and a tool still mid-flight at `done` would be a different bug
// (the SDK closes the turn after its results) that this must not paper over.

import { describe, expect, it } from 'vitest'
import { settleUnfinishedToolParts } from './settleParts'
import { isToolCallInFlight } from '@/chat/types'
import type { MessagePart } from '@/chat/types'

const tool = (id: string, state: string): MessagePart =>
  ({ type: 'tool', id, toolName: 'Read', state, input: {} }) as unknown as MessagePart
const text = (id: string): MessagePart =>
  ({ type: 'text', id, text: 'hi' }) as unknown as MessagePart

describe('settleUnfinishedToolParts', () => {
  it('turns a tool call that never returned into an error, on a stopped turn', () => {
    const out = settleUnfinishedToolParts([tool('a', 'input-available')], 'stopped')
    expect(out[0]).toMatchObject({ id: 'a', state: 'output-error' })
    // The product's own predicate decides what "in flight" means — restating
    // the state list here is how the copy would drift.
    expect(isToolCallInFlight(out[0] as never)).toBe(false)
  })

  it('covers both in-flight states', () => {
    const out = settleUnfinishedToolParts(
      [tool('a', 'input-streaming'), tool('b', 'input-available')],
      'error',
    )
    expect(out.every((p) => !isToolCallInFlight(p as never))).toBe(true)
  })

  it('leaves a turn that finished cleanly alone', () => {
    const parts = [tool('a', 'input-available')]
    expect(settleUnfinishedToolParts(parts, 'done')).toBe(parts)
  })

  it('leaves already-terminal tool parts and non-tool parts untouched', () => {
    const parts = [tool('a', 'output-available'), tool('b', 'output-error'), text('c')]
    const out = settleUnfinishedToolParts(parts, 'stopped')
    expect(out).toEqual(parts)
  })

  it('does not mutate the input array or its parts', () => {
    const original = tool('a', 'input-available')
    const parts = [original]
    settleUnfinishedToolParts(parts, 'stopped')
    expect(original).toMatchObject({ state: 'input-available' })
    expect(parts).toHaveLength(1)
  })
})
