// Handler for `claude:proposal` sidecar events. Runs the proposal
// through markStore (`applyProposal`), records the outcome in
// `toolCalls`, and stamps the resulting markId onto the matching
// ToolPart so the chat panel can navigate to it.
//
// Why a separate module: the listener has three responsibilities
// (slug guard, mark application, ToolPart correlation) that all
// hang off a single sidecar event. Pulling the handler into a
// factory keeps the engine wiring (listen + cleanup) terse and
// lets the proposal flow be tested without the rest of runChat.

import { applyProposal } from '@/agent/applyProposal'
import { useDocsStore } from '@/state/docsStore'
import type { ProposalEvent, ToolCallRecord } from './types'
import type { StreamParser } from './streamParser'

export interface ProposalListenerArgs {
  /** Run id this listener is bound to — events from other runs are
   * ignored. */
  runId: string
  /** Slug of the doc the run was started against. Used both for the
   * "doc closed?" guard and as the apply target. */
  slug: string
  /** Agent identifier stamped onto the mark via apply meta. */
  agentId: string
  /** Mutable list the engine reads at settle time. The listener
   * pushes each successful (or failed) apply outcome here so
   * RunChatResult.toolCalls reflects everything the model
   * triggered. */
  toolCalls: ToolCallRecord[]
  /** Stream parser the listener correlates with — `findPendingProposalPart`
   * locates the ToolPart created by the matching tool_use block,
   * and `stampProposalApplied` writes the markId onto its output. */
  parser: StreamParser
  /** Optional callback fired for each apply attempt (success or
   * failure). Mirrors the long-standing engine surface. */
  onToolApplied?: (call: ToolCallRecord) => void
}

/** Build the async event handler for `claude:proposal`. The returned
 * function is shape-compatible with Tauri's `listen` callback. */
export function createProposalListener(args: ProposalListenerArgs) {
  const { runId, slug, agentId, toolCalls, parser, onToolApplied } = args
  return async (e: { payload: ProposalEvent }): Promise<void> => {
    if (e.payload.runId !== runId) return
    // applyProposal writes directly to the doc's Y.Doc + Y.Map.
    // The handle for `slug` must be open in this session — if it
    // isn't (slug closed / archived), drop the proposal. The
    // sidecar emits events for a beat after run cancel; the guard
    // keeps a late event from mutating a doc the user clearly
    // walked away from.
    const handle = useDocsStore.getState().handles[slug]
    if (!handle) {
      console.warn('[chat] proposal for closed doc dropped', { slug, runId })
      return
    }
    const meta = { runId, agentId }
    const outcome = await applyProposal(slug, e.payload.input, meta)
    const record: ToolCallRecord = {
      id: crypto.randomUUID(),
      name: 'propose_change',
      input: e.payload.input,
      result: outcome,
    }
    toolCalls.push(record)
    onToolApplied?.(record)
    // Stamp the markId onto the matching ToolPart so the chat
    // panel's click-to-scroll handler can find it. The SDK's
    // tool_result that arrives a beat later only carries the ack
    // text from the relay handler.
    if (outcome.ok) {
      const part = parser.findPendingProposalPart()
      if (part) parser.stampProposalApplied(part, outcome.markId)
    }
  }
}
