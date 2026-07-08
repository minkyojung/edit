// Chat → wiki handoff. The "feedback" half of Karpathy's bidirectional
// loop: a chat reply (or user statement) the user explicitly files goes to
// the same general intake agent the inbox uses, which proposes wiki edits
// into the standard approval queue.
//
// Manual only — invoked from the assistant message UI when the user says
// "file this into the wiki". Reuses runIntake (general agent + propose_*),
// so there is no structured engine, no direct write, and no auto-commit:
// every proposal is reviewed like any other edit, then committed on Keep.

import { runIntake } from '@/agent/intake'
import type { RunChatResult } from '@/agent/chat/types'

export interface ChatHandoffArgs {
  /** Assistant or user message body to file. Empty / whitespace-only inputs
   * short-circuit with a null result. */
  messageContent: string
  /** Thread id — attributes the run to the originating thread. */
  threadId: string
  /** Thread title — kept for caller compatibility (toasts / labels). */
  threadTitle: string
}

/** Hand a chat message to the intake agent; it proposes any durable wiki
 * edits into the standard approval queue. Returns the run result (or null
 * for empty input). Errors propagate so the caller can surface them. */
export async function runChatToWikiHandoff(
  args: ChatHandoffArgs,
): Promise<RunChatResult | null> {
  const trimmed = args.messageContent.trim()
  if (!trimmed) return null

  // Native: expand the `/chat-to-wiki` plugin command into the user turn; the
  // chat content rides along as the appended DOCUMENT block (no path argument —
  // the command body reads "the document below").
  return runIntake({
    slug: args.threadId,
    prompt: '/chat-to-wiki',
    content: trimmed,
  })
}
