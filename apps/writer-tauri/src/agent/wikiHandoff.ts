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

/** Routing brain for a chat→wiki handoff. Wiki-only (no daily): the chat
 * content is filed as durable knowledge or skipped. Exported so BootGate can
 * seed it as the `.claude/commands/chat-to-wiki.md` default. */
export const HANDOFF_PROMPT = `You are filing content the user picked from a chat into their wiki. The content is in the document below. Extract only durable, reusable knowledge — a specific non-obvious fact about an entity (a person, book, project, idea), or a concept / framework / method the user will look up later.

Propose each kept fact as an edit to the matching wiki page: find it via \`_system/index.md\` + \`Glob\` / \`Grep\` on \`wiki/\`, then \`propose_edit\` to append a bullet (anchor on a line that exists), or \`propose_write\` a new \`wiki/<Title>.md\` when no page fits. Append only — never rewrite existing lines. Cross-reference related pages with [[Page Title]] using exact index titles.

Skip the chat narrative, the assistant's own phrasing, transient remarks, and anything not worth re-finding. If nothing is durable, propose nothing.`

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
