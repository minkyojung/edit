// Context engineering pipeline facade — one call site that assembles
// the LLM-facing context bundle for both chat and ingest consumers.
//
// As of the Karpathy / Claude Code alignment, chat and ingest share
// the same prefix shape:
//
//   prefix (caching-friendly):
//     - CLAUDE.md         (vault schema + conventions, user-editable)
//     - SELF PROFILE      (wiki:profile body)
//
//   suffix (consumer-specific):
//     - chat embeds the current document past the SDK cache boundary
//     - ingest embeds the new daily blocks as the user message
//
// The wiki index + page bodies that the previous ingest shape
// dumped into the system prompt are intentionally absent: ingest
// is now an agent loop that uses Read / Glob / Grep to navigate the
// vault on demand (Anthropic's "Claude Code" pattern, validated
// across SWE-bench / agentic benchmarks). That fixes the same
// "unrelated context pulls in random wiki pages" failure mode chat
// already fixed and lets the two flows share a cache prefix.
//
// Durable facts about the user are NOT carried as a separate "agent
// memory" surface — they live in the wiki (entity pages + the
// self-profile), which the agent edits through the normal proposal
// flow and which is already injected here. There is no hidden
// always-on scratchpad the agent writes to behind the user's back.

import { readClaudeMd, readSelfProfile } from '@/state/wikiService'

export interface ContextBundle {
  /** Vault-root `CLAUDE.md` body. Karpathy / Claude Code schema
   * document — vault layout, three-tier rules, operations, tool
   * usage guidance, citation conventions. Shipped in both modes. */
  claudeMd: string
  /** User self-profile (`wiki:profile`) body. Grounds "who the user
   * is" before every downstream block. Empty when the page doesn't
   * exist yet. */
  selfProfile: string
  /** Rough character count of the user-facing payload — diagnostics
   * only. */
  budgetUsed: number
}

/** Assemble the LLM-facing context bundle. Concurrent reads under
 * the hood — independent state, so we fire them in parallel. */
export async function assembleContext(): Promise<ContextBundle> {
  const [claudeMd, selfProfile] = await Promise.all([
    readClaudeMd(),
    readSelfProfile(),
  ])

  const budgetUsed = claudeMd.length + selfProfile.length

  return {
    claudeMd,
    selfProfile,
    budgetUsed,
  }
}
