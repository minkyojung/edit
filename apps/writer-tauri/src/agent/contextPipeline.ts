// Context engineering pipeline facade — one call site that assembles
// the LLM-facing context bundle. Two consumers (chat, ingest) share
// the function but ask for different shapes via `mode`.
//
//   chat   — Karpathy / Claude Code pattern: only the always-on
//            schema (`CLAUDE.md`, profile, conventions) lands in the
//            prefix. Catalogue + page bodies are fetched by the LLM
//            via Read / Glob / Grep tools when needed. Stops the
//            "unrelated chat pulls in random wiki pages" failure
//            mode that the previous always-dump shape produced.
//
//   ingest — Legacy shape preserved for the ingest pipeline. Bundles
//            the wiki index + hot-page bodies up front so the
//            structured-output run has the full catalog without
//            extra tool round-trips. We will revisit ingest in a
//            follow-up phase; for now its behaviour stays unchanged.
//
// The bundle returns raw strings + structured page bodies, NOT a
// pre-formatted prompt block. Each consumer decides how to layer
// the pieces into its system prompt.

import { getWikiIndex } from '@/state/wikiIndex'
import { readClaudeMd, readConventions, readSelfProfile } from '@/state/wikiService'
import { selectHotPages, type WikiPageBody } from './contextSelector'

/** Names of Tier 3 tools available when the sidecar has a vault path.
 * Consumers add these to their relayTools list to opt into LLM-driven
 * page fetch / search. Sidecar (server.mjs) is the source of truth
 * for what's actually registered — these strings just have to match. */
const DEFAULT_TOOLS = ['read_page', 'search_wiki'] as const
export type Tier3ToolName = (typeof DEFAULT_TOOLS)[number]

export type AssembleContextMode = 'chat' | 'ingest'

export interface ContextBundle {
  /** Vault-root `CLAUDE.md` body. Karpathy / Claude Code schema
   * document — vault layout, three-tier rules, operations, tool
   * usage guidance, citation conventions. Only present in chat
   * mode; ingest mode leaves it empty (the ingest prompt embeds
   * its own structured guidance). */
  claudeMd: string
  /** Tier 1 — one-line summary of every wiki page. Only present in
   * ingest mode. Chat mode leaves this empty; the LLM `Read`s
   * `_system/index.md` directly when the question warrants it. */
  index: string
  /** Tier 2 — pages mentioned in the source via `[[...]]`, with full
   * bodies. Only present in ingest mode. Chat mode leaves this empty;
   * the LLM `Read`s individual pages on demand. */
  hotPages: WikiPageBody[]
  /** User-editable schema document (`wiki:conventions`). Shipped in
   * both modes — small, cache-friendly, and central to how the LLM
   * understands the user's preferences. */
  conventions: string
  /** User self-profile (`wiki:profile`) body. Shipped in both modes
   * — small, cache-friendly, and grounds "who the user is" before
   * every downstream block. Empty when the page doesn't exist yet. */
  selfProfile: string
  /** Tier 3 tool names the consumer should pass to `relayTools` on
   * the `claude_chat_start` invoke. Empty array when the caller
   * opts out via `enableTools: false`. */
  tools: Tier3ToolName[]
  /** Rough character count of the user-facing payload — diagnostics
   * and budget gating only. */
  budgetUsed: number
}

export interface AssembleContextOptions {
  /** Which consumer is calling. `'chat'` returns the Karpathy
   * agent-fetch shape (CLAUDE.md only, no index / hot pages);
   * `'ingest'` returns the legacy dump shape until that pipeline
   * is migrated. Defaults to `'ingest'` so existing callers (the
   * ingest pipeline) get unchanged behaviour without code changes. */
  mode?: AssembleContextMode
  /** Pre-read body of the doc the LLM is acting on. Ingest passes
   * the daily being ingested; chat doesn't need this (the chat
   * runner pins the live editor doc past the cache boundary
   * itself). */
  docBody?: string
  /** User chat query. Only used by ingest's hot-page selector; the
   * chat path doesn't auto-extract wikilinks anymore — that was
   * the source of the unrelated-page-pull failure mode. */
  text?: string
  /** Total character budget for Tier 2 hot pages. Caller decides
   * based on remaining headroom after the rest of its prompt is
   * formatted. Defaults to the selector's internal 30K-char limit. */
  budgetChars?: number
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

  // Always-on blocks — small, cache-friendly, both modes use them.
  const baseReads = Promise.all([readConventions(), readSelfProfile()])

  // Mode-specific blocks fire in parallel with the base reads.
  const chatReads = mode === 'chat' ? readClaudeMd() : Promise.resolve('')
  const ingestReads =
    mode === 'ingest'
      ? Promise.all([
          getWikiIndex(),
          selectHotPages(
            { dailyBody: opts.docBody, queryText: opts.text },
            { budgetChars: opts.budgetChars },
          ),
        ])
      : Promise.resolve(['', [] as WikiPageBody[]] as const)

  const [[conventions, selfProfile], claudeMd, [index, hotPages]] = await Promise.all([
    baseReads,
    chatReads,
    ingestReads,
  ])

  const tools: Tier3ToolName[] =
    opts.enableTools === false ? [] : [...DEFAULT_TOOLS]

  const budgetUsed =
    claudeMd.length +
    index.length +
    hotPages.reduce((sum, p) => sum + p.body.length, 0) +
    conventions.length +
    selfProfile.length

  return {
    claudeMd,
    index,
    hotPages,
    conventions,
    selfProfile,
    tools,
    budgetUsed,
  }
}
