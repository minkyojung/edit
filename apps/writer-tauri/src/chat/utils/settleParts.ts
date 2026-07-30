// Closing out a turn that did not finish cleanly.
//
// A tool call's row is driven by its `state`, and the two pre-result states
// render as a spinner (`isToolCallInFlight`). On a normal turn every call
// reaches a result, so the spinner always stops. On a turn that was stopped,
// errored, or had its thread torn out from under it, the last call never gets
// one — and `commit()` persists the parts verbatim, so the transcript keeps a
// spinner animating a call that ended, across restarts.
//
// Kept out of the parser deliberately: `StreamParser` sees events, not turns,
// and has no notion of "this turn ended badly". `commit()` is the one place
// that knows.

import { isToolCallInFlight, type MessagePart, type ChatTurn } from '@/chat/types'

/** Mark tool calls that never returned as failed, for a turn ending in any
 *  status other than `done`.
 *
 *  Returns the input array unchanged (same reference) when there is nothing to
 *  do, so the common path allocates nothing and a caller may compare by
 *  identity. `done` is left strictly alone: a call still in flight there would
 *  be a different defect, and rewriting it would hide it. */
export function settleUnfinishedToolParts(
  parts: MessagePart[],
  finalStatus: ChatTurn['status'],
): MessagePart[] {
  if (finalStatus === 'done') return parts
  let changed = false
  const out = parts.map((p) => {
    if (p.type !== 'tool' || !isToolCallInFlight(p)) return p
    changed = true
    return { ...p, state: 'output-error' as const }
  })
  return changed ? out : parts
}
