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
  readClaudeMd,
  readConventions,
  readSelfProfile,
  readWorking,
} from '@/state/wikiService'

/** Names of Tier 3 MCP tools the chat path opts into when the
 * sidecar has a vault path. Ingest does NOT include these in
 * `relayTools` — it relies on the SDK's built-in Read / Glob / Grep
 * preset (sidecar enables it via `tools: { preset: 'claude_code' }`)
 * plus its own `submit_ingest_result` output tool. Listing the chat
 * tools here keeps the chat call site unchanged. */
const DEFAULT_TOOLS = ['read_page', 'search_wiki'] as const
export type Tier3ToolName = (typeof DEFAULT_TOOLS)[number]

export type AssembleContextMode = 'chat' | 'ingest'

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
  /** Tier 3 tool names the chat consumer should pass to
   * `relayTools`. Empty in ingest mode and when the chat caller
   * opts out via `enableTools: false`. */
  tools: Tier3ToolName[]
  /** Rough character count of the user-facing payload — diagnostics
   * only. */
  budgetUsed: number
}

export interface AssembleContextOptions {
  /** Which consumer is calling. Both modes now return the same
   * shape (CLAUDE.md + profile + conventions); the only behavioural
   * difference is the default `tools` array. */
  mode?: AssembleContextMode
  /** When `false`, returns an empty `tools` array — for callers
   * that explicitly don't want LLM-driven fetch. Default `true`. */
  enableTools?: boolean
}

/** Assemble the LLM-facing context bundle. Concurrent reads under
 * the hood — independent state, so we fire them in parallel. */
export async function assembleContext(
  opts: AssembleContextOptions = {},
): Promise<ContextBundle> {
  const mode: AssembleContextMode = opts.mode ?? 'ingest'

  const [claudeMd, conventions, selfProfile, working] = await Promise.all([
    readClaudeMd(),
    readConventions(),
    readSelfProfile(),
    readWorking(),
  ])

  // Tier-3 MCP tools are chat-specific. Ingest uses the SDK's
  // built-in Read / Glob / Grep preset + its own structured-output
  // tool, so the array stays empty here regardless of `enableTools`.
  const tools: Tier3ToolName[] =
    mode === 'chat' && opts.enableTools !== false ? [...DEFAULT_TOOLS] : []

  const budgetUsed =
    claudeMd.length + conventions.length + selfProfile.length + working.length

  return {
    claudeMd,
    conventions,
    selfProfile,
    working,
    tools,
    budgetUsed,
  }
}
