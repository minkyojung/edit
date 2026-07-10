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

// Role-framed routing brain (was the `/chat-to-wiki` command body). Leans on the
// vault's CLAUDE.md — injected alongside — for the mechanics (index navigation,
// append via propose_*, [[...]] links); this states the agent's role and WHAT to
// keep, not the procedure. The chat content arrives as the appended DOCUMENT.
const CHAT_TO_WIKI_BRAIN = `You are the wiki maintainer, tending the user's second brain. Your job right now: take the message below — content the user filed from a chat — and move its durable knowledge into the wiki, per the vault's CLAUDE.md schema and editing rules.

Keep only what's worth re-finding later — a specific, non-obvious fact about an entity (a person, book, project, idea), or a concept, framework, or method. Drop the chat narrative, the assistant's own phrasing, and transient remarks. Skip anything the wiki already holds.

Propose your additions through the approval queue; if nothing is durable, propose nothing.`

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

  // The routing brain rides as the system prompt; the chat content rides along
  // as the appended DOCUMENT block (the brain reads "the message below").
  return runIntake({
    slug: args.threadId,
    systemPrompt: CHAT_TO_WIKI_BRAIN,
    prompt: 'File the durable knowledge from the message below into the wiki.',
    content: trimmed,
  })
}
