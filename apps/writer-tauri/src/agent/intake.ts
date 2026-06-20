// Intake runner — the Claude Code-native replacement for the structured
// ingest engine. Hands content to the ordinary chat agent with a routing
// instruction and lets it propose wiki/daily edits directly via
// propose_edit / propose_write (gated through the pending-changes approval
// flow). No structured-output contract, no parse step, no separate apply
// layer — the agent does the work and the existing approval flow stages it.
//
// Callers (inbox capture, daily ingest, chat→wiki handoff) supply their own
// system prompt (the routing brain) and kickoff message; everything else —
// built-in Read/Glob/Grep, the propose_* tools, the headless run — is shared.

import { runChat } from '@/agent/chat'
import type { RunChatResult } from '@/agent/chat/types'
import { getIntakeModel } from '@/state/settingsStore'

export interface IntakeArgs {
  /** Doc slug to attribute the run to (proposals route through it). */
  slug: string
  /** The routing brain — system prompt telling the agent where content goes. */
  systemPrompt: string
  /** Kickoff user message (e.g. "Read the note at X and route it"). */
  prompt: string
  /** Raw content to inject when there's no readable vault file to point at
   * (e.g. a chat message the user sends to the wiki). When omitted, the agent
   * Reads the file itself — the Claude Code-native path. */
  content?: string
}

/** Run one general-agent intake pass and return the run result. Proposals land
 * in the pending-changes queue for the user to approve. */
export async function runIntake(args: IntakeArgs): Promise<RunChatResult> {
  return runChat({
    // Headless: no editor view (same shape the Read-Later queue uses).
    view: null,
    slug: args.slug,
    threadId: crypto.randomUUID(),
    // User-configurable in settings (default Sonnet; Haiku for cheap bulk).
    model: getIntakeModel(),
    // Inject raw content only when given; otherwise the agent reads the file.
    appendDocument: args.content != null,
    pageContextMarkdown: args.content,
    prompt: args.prompt,
    systemPrompt: args.systemPrompt,
    // Read/Glob/Grep come from the built-in preset; these are the write-side
    // tools the agent proposes through.
    relayTools: ['propose_edit', 'propose_multi_edit', 'propose_write'],
  })
}
