// Context engineering pipeline facade — one call site that assembles
// the LLM-facing context bundle for both chat and ingest consumers.
//
// As of the Karpathy / Claude Code alignment, chat and ingest share
// the same prefix shape:
//
//   prefix (caching-friendly):
//     - CLAUDE.md         (vault schema, user-editable)
//     - SELF PROFILE      (wiki:profile body)
//     - CONVENTIONS       (wiki:conventions body)
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

import {
  readAgentMemory,
  readClaudeMd,
  readConventions,
  readSelfProfile,
  readWorking,
} from '@/state/wikiService'

export interface ContextBundle {
  /** Vault-root `CLAUDE.md` body. Karpathy / Claude Code schema
   * document — vault layout, three-tier rules, operations, tool
   * usage guidance, citation conventions. Shipped in both modes. */
  claudeMd: string
  /** User-editable schema document (`wiki:conventions`). Small,
   * cache-friendly, central to how the LLM understands the user's
   * preferences. */
  conventions: string
  /** User self-profile (`wiki:profile`) body. Grounds "who the user
   * is" before every downstream block. Empty when the page doesn't
   * exist yet. */
  selfProfile: string
  /** Working memory (`system:working`) body — the user's current,
   * fast-changing context (active projects, near deadlines, recent
   * focus). Always loaded but kept small. Empty when the page doesn't
   * exist yet. */
  working: string
  /** Active agent's long-term memory (`system:memory:<id>` body). Empty
   * when the caller passes no `agentMemoryType` (ingest) or the page is
   * blank. Injected into the chat system prompt right after working
   * memory. */
  agentMemory: string
  /** Rough character count of the user-facing payload — diagnostics
   * only. */
  budgetUsed: number
}

export interface AssembleContextOptions {
  /** Active agent's memory doc type (`system:memory:<id>`, from
   * Agent.memoryType). When set, the agent's memory body is read and
   * returned as `agentMemory`. Omitted → `agentMemory` is ''. */
  agentMemoryType?: string
}

/** Assemble the LLM-facing context bundle. Concurrent reads under
 * the hood — independent state, so we fire them in parallel. */
export async function assembleContext(
  opts: AssembleContextOptions = {},
): Promise<ContextBundle> {
  const [claudeMd, conventions, selfProfile, working, agentMemory] =
    await Promise.all([
      readClaudeMd(),
      readConventions(),
      readSelfProfile(),
      readWorking(),
      opts.agentMemoryType ? readAgentMemory(opts.agentMemoryType) : Promise.resolve(''),
    ])

  const budgetUsed =
    claudeMd.length +
    conventions.length +
    selfProfile.length +
    working.length +
    agentMemory.length

  return {
    claudeMd,
    conventions,
    selfProfile,
    working,
    agentMemory,
    budgetUsed,
  }
}
