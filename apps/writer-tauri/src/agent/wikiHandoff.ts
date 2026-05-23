// Chat → wiki handoff. The "feedback" half of Karpathy's bidirectional
// loop: a chat reply (or user statement) gets routed through the same
// ingest engine the daily pass uses, and any durable facts the model
// surfaces land in the existing review queue.
//
// Invoked from the assistant message UI when the user explicitly says
// "file this into the wiki" — never automatic. Manual gating is the
// signal-to-noise lever; daily-style passes are too eager for casual
// chat. See docs/refactor-proof-sdk-removal/06-wiki-completion.md and
// the plan at ~/.claude/plans/starry-booping-turing.md for the
// rationale (Option A — manual trigger).
//
// Reuses `runIngestCore` verbatim. The `chat:` prefix on `sourceLabel`
// is the only signal the engine needs — `buildPrompt` branches on it
// to tighten extraction (chat replies mix the user's direct statements
// with the assistant's narrative; the daily-tone prompt over-extracts
// otherwise). No new tool, no new prompt, no new banner UI.

import { runIngestCore } from '@/agent/ingest/index'
import { useIngestStore } from '@/state/ingestStore'

export interface ChatHandoffArgs {
  /** Assistant or user message body to extract facts from. Empty /
   * whitespace-only inputs short-circuit with `enqueued: 0`. */
  messageContent: string
  /** Thread id — used as `sourceSlug` so the inbox groups by
   * originating thread, the same way daily passes group by note slug. */
  threadId: string
  /** Thread title — surfaces in banner cards as `chat: <title>`. Falls
   * back to `Untitled thread` when blank. */
  threadTitle: string
}

export interface ChatHandoffResult {
  /** Count of wiki proposals enqueued for review. Zero is a normal
   * outcome — the model judged the message had nothing durable. */
  enqueued: number
  /** Deduped routing keys for proposals that landed: a `wiki:*` type
   * id for appends, or `new:<name>` for `suggestNewPage` proposals.
   * Useful for the toast ("queued 2 — review on Sarah, Tom"). */
  affectedTargets: string[]
  /** True when the model emitted text but didn't call the structured
   * tool. Caller can show a soft warning rather than treating as
   * silent success. */
  malformed: boolean
}

/** Hand a chat message off to the ingest engine and enqueue any
 * resulting wiki proposals into the standard review queue. The
 * returned shape is meant to drive a toast / inline confirmation —
 * the actual review happens later when the user opens the affected
 * wiki page and the banner surfaces the cards.
 *
 * No-throw contract: transport / SDK errors propagate (callers can
 * surface them), but a malformed model response resolves with
 * `malformed: true` rather than rejecting. Empty inputs resolve with
 * a zero result. */
export async function runChatToWikiHandoff(
  args: ChatHandoffArgs,
): Promise<ChatHandoffResult> {
  const trimmed = args.messageContent.trim()
  if (!trimmed) {
    return { enqueued: 0, affectedTargets: [], malformed: false }
  }

  const label = `chat: ${args.threadTitle.trim() || 'Untitled thread'}`
  const core = await runIngestCore({ text: trimmed, sourceLabel: label })

  if (core.malformed) {
    return { enqueued: 0, affectedTargets: [], malformed: true }
  }
  if (core.proposals.length === 0 && !core.logEntry) {
    return { enqueued: 0, affectedTargets: [], malformed: false }
  }

  useIngestStore.getState().enqueue({
    proposals: core.proposals,
    logEntry: core.logEntry,
    sourceSlug: args.threadId,
    sourceLabel: label,
  })

  const targets = Array.from(
    new Set(
      core.proposals
        .map((p) =>
          p.target ?? (p.suggestNewPage ? `new:${p.suggestNewPage}` : null),
        )
        .filter((t): t is string => t !== null),
    ),
  )
  return {
    enqueued: core.proposals.length,
    affectedTargets: targets,
    malformed: false,
  }
}
