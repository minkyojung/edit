// Handler for `claude:edit` sidecar events. The Phase 3.C replacement
// for `proposalListener` — same shape, different terminal action:
// rather than calling `applyProposal` (which wrote a Y.Map mark and
// left the edit visible only via a hover popover), we now call
// `applyDirectEdit` to splice the doc body in-place.
//
// Each successful edit bumps `acc.count` so the engine can build a
// per-turn commit message ("ai-edit: chat reply (3 edits)") and
// emit one git commit covering every edit the model made in a
// single response. That matches the Phase 2.A ingest convention:
// one logical action = one commit, never per-bullet.

import {
  applyDirectEdit,
  type DirectEdit,
  type EditOutcome,
} from '@/agent/applyDirectEdit'
import { useDocsStore } from '@/state/docsStore'
import type { EditEvent, ToolCallRecord } from './types'

export interface EditCounter {
  /** Number of successful applyDirectEdit calls in this run. The
   * engine reads this when deciding whether to commit (count > 0). */
  count: number
}

export interface EditListenerArgs {
  /** Run id this listener is bound to — events from other runs are
   * ignored. */
  runId: string
  /** Slug of the doc the run was started against. Captured at chat
   * launch so a doc switch mid-stream still edits the doc the user
   * was looking at when they typed. */
  slug: string
  /** Mutable list the engine reads at settle time. The listener
   * pushes each apply outcome here so RunChatResult.toolCalls
   * reflects everything the model did. */
  toolCalls: ToolCallRecord[]
  /** Shared counter bumped on every successful edit. Lives outside
   * `toolCalls` so the engine can read it without walking the list
   * (and so test code can assert on it directly). */
  acc: EditCounter
  /** Optional callback fired for each apply attempt (success or
   * failure). Mirrors the proposalListener surface so the
   * useChatRunner hook plumbing didn't need to learn a new shape. */
  onToolApplied?: (call: ToolCallRecord) => void
}

/** Wraps the create function in the listener shape Tauri's `listen`
 * expects. The returned function is also `async (e) => Promise<void>`
 * so unhandled rejections surface naturally. */
export function createEditListener(args: EditListenerArgs) {
  const { runId, slug, toolCalls, acc, onToolApplied } = args
  return async (e: { payload: EditEvent }): Promise<void> => {
    if (e.payload.runId !== runId) return
    // Drop late events for docs the user has closed since the run
    // started — same guard the old proposalListener used. The
    // sidecar continues to emit briefly after a cancel; without
    // this we'd silently mutate an off-screen doc.
    const handle = useDocsStore.getState().handles[slug]
    if (!handle) {
      console.warn('[chat] edit for closed doc dropped', { slug, runId })
      return
    }
    const outcome = await applyDirectEdit(slug, e.payload.input as DirectEdit)
    const record: ToolCallRecord = {
      id: crypto.randomUUID(),
      name: 'edit_document',
      input: e.payload.input,
      result: outcome,
    }
    toolCalls.push(record)
    onToolApplied?.(record)
    if (outcome.ok) acc.count += 1
  }
}

/** Format a multi-line commit body summarising each edit in a turn.
 * The first 80 chars of `quote` get echoed (longer quotes truncate
 * with an ellipsis) so the Review-panel detail view can show what
 * was actually swapped without dragging the full doc context in. */
export function buildEditCommitBody(
  records: ToolCallRecord[],
  sourceLabel: string,
): string {
  const successful = records.filter((r) => r.result.ok)
  if (successful.length === 0) return ''
  const blocks: string[] = []
  for (const r of successful) {
    const input = r.input as DirectEdit
    const quote = truncate(input.quote, 80)
    const content = truncate(input.content, 80)
    const lines = [`Edit: "${quote}" → "${content}"`]
    if (input.rationale) lines.push(`  Why: ${input.rationale}`)
    blocks.push(lines.join('\n'))
  }
  blocks.push(`From: ${sourceLabel}`)
  return blocks.join('\n\n')
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max).trimEnd() + '…'
}

/** Re-exported so the engine call site can name the type without
 * pulling applyDirectEdit's internal exports. */
export type { EditOutcome }
