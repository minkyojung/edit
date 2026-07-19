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

import { readClaudeMd, readSelfProfileWithMeta, readPreferences } from '@/state/wikiService'
import { splitOutBackground } from '@/profile/markers'

export interface ContextBundle {
  /** The app-owned schema document (Karpathy / Claude Code shape —
   * vault layout, role model, operations, tool usage, citation
   * conventions). Now shipped from the app BUNDLE, not the vault, so
   * schema improvements reach every vault on the next build and the
   * user's files are never overwritten. Shipped in both modes. */
  claudeMd: string
  /** User self-profile (`wiki:profile`) — the bounded SUMMARY zones only
   * (Voice / Themes / About / Sources / Notes). The growing, append-only
   * `## Background` zone is intentionally NOT here; it loads on demand (see
   * {@link selfProfileBackgroundPath}) so it can't bloat the always-on
   * context as facts accrue. Empty when the page doesn't exist yet. */
  selfProfile: string
  /** Vault-relative path of the profile page, present ONLY when its
   * `## Background` zone has content. The system prompt turns this into a
   * one-line pointer telling the model to Read the file when it needs a
   * specific personal fact the summary doesn't cover. Null = no Background to
   * fetch (so no pointer). */
  selfProfileBackgroundPath: string | null
  /** User behaviour preferences (`_system/preferences.md`) — how the
   * agent should act/format output. The one per-user slice carved out
   * of the old CLAUDE.md; the agent appends to it via the proposal
   * flow. Empty until the user sets any. */
  preferences: string
  /** Rough character count of the user-facing payload — diagnostics
   * only. */
  budgetUsed: number
}

/** Assemble the LLM-facing context bundle. Concurrent reads under
 * the hood — independent state, so we fire them in parallel. */
export async function assembleContext(): Promise<ContextBundle> {
  const [claudeMd, profile, preferences] = await Promise.all([
    readClaudeMd(),
    readSelfProfileWithMeta(),
    readPreferences(),
  ])

  // Keep the bounded summary always-on; carve out the growing Background for
  // on-demand loading. The pointer is only meaningful when there's Background
  // content AND we know the file path to send the model to.
  const { summary: selfProfile, background } = splitOutBackground(profile.body)
  const selfProfileBackgroundPath =
    background && profile.relPath ? profile.relPath : null

  const budgetUsed = claudeMd.length + selfProfile.length + preferences.length

  return {
    claudeMd,
    selfProfile,
    selfProfileBackgroundPath,
    preferences,
    budgetUsed,
  }
}
