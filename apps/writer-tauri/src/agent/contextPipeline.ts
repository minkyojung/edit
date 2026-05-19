// Context engineering pipeline facade — one call site that pulls
// Tier 1 (catalog) + Tier 2 (hot pages) + conventions, plus the
// names of Tier 3 tools the consumer should enable on this run.
//
// Every consumer that calls the LLM with wiki context (chat,
// ingest, lint) routes through assembleContext. The benefit is
// twofold:
//
//   1. Single place to evolve "what does the LLM see?". Want to
//      add a recent-activity block, drop conventions for a token-
//      tight run, swap Tier 2 ranking? One file changes.
//
//   2. Symmetric consumer code. chat / ingest / lint all assemble
//      the same shape, then format it for their own prompt. No
//      one re-implements catalog fetching or hot-page selection.
//
// The bundle returns raw strings + structured page bodies, NOT a
// pre-formatted prompt block. Each consumer decides how to layer
// the pieces into its system prompt (e.g. ingest pins log entries
// at the end for cache stability; lint puts the daily under review
// as the user message; chat threads conventions and index together
// as cacheable prefix). Centralising the prompt format too would
// couple unrelated concerns — we keep that local to each consumer.

import { getWikiIndex } from '@/state/wikiIndex'
import { readConventions } from '@/state/wikiService'
import { selectHotPages, type WikiPageBody } from './contextSelector'

/** Names of Tier 3 tools available when the sidecar has a vault path.
 * Consumers add these to their relayTools list to opt into LLM-driven
 * page fetch / search. Sidecar (server.mjs) is the source of truth
 * for what's actually registered — these strings just have to match. */
const DEFAULT_TOOLS = ['read_page', 'search_wiki'] as const
export type Tier3ToolName = (typeof DEFAULT_TOOLS)[number]

export interface ContextBundle {
  /** Tier 1 — one-line summary of every wiki page. Cheap to ship in
   * every prompt; the LLM scans this to know what targets exist. */
  index: string
  /** Tier 2 — pages mentioned in the source via `[[...]]`, with full
   * bodies. The LLM gets these without having to fetch them. */
  hotPages: WikiPageBody[]
  /** User-editable schema document (`wiki:conventions`). The LLM
   * prepends these to the system prompt so the user can shape how
   * the wiki grows without touching code. Empty string when the
   * page doesn't exist yet or is genuinely blank. */
  conventions: string
  /** Tier 3 tool names the consumer should pass to `relayTools` on
   * the `claude_chat_start` invoke. Empty array when the caller
   * opts out via `enableTools: false`. */
  tools: Tier3ToolName[]
  /** Rough character count of the user-facing payload (index +
   * hot pages + conventions). Useful for diagnostics and for the
   * consumer to decide whether to drop a section if it's about
   * to bust the prompt budget. */
  budgetUsed: number
}

export interface AssembleContextOptions {
  /** Pre-read body of the doc the LLM is acting on. Lint passes
   * the daily being reviewed; ingest passes the daily being
   * ingested. Wikilinks in this body surface their target pages
   * as Tier 2 hot context. Mutually exclusive with `text` in
   * practice; if both arrive they're concatenated for extraction. */
  docBody?: string
  /** User chat query. Same wikilink-extraction rules apply. */
  text?: string
  /** Total character budget for Tier 2 hot pages. Caller decides
   * based on remaining headroom after the rest of its prompt is
   * formatted. Defaults to the selector's internal 30K-char limit. */
  budgetChars?: number
  /** When `false`, returns an empty `tools` array — for callers
   * that explicitly don't want LLM-driven fetch (very rare; today
   * no consumer sets this). Default `true`. */
  enableTools?: boolean
}

/** Assemble the LLM-facing context bundle. Concurrent reads under
 * the hood — index cache, hot-page selector, conventions read all
 * fire in parallel since they touch independent state. */
export async function assembleContext(
  opts: AssembleContextOptions = {},
): Promise<ContextBundle> {
  const [index, hotPages, conventions] = await Promise.all([
    getWikiIndex(),
    selectHotPages(
      { dailyBody: opts.docBody, queryText: opts.text },
      { budgetChars: opts.budgetChars },
    ),
    readConventions(),
  ])

  const tools: Tier3ToolName[] =
    opts.enableTools === false ? [] : [...DEFAULT_TOOLS]

  const budgetUsed =
    index.length +
    hotPages.reduce((sum, p) => sum + p.body.length, 0) +
    conventions.length

  return { index, hotPages, conventions, tools, budgetUsed }
}
