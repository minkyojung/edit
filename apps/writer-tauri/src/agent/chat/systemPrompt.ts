// Prompt assembly for the chat runner. Two surfaces:
//
//   buildUserPrompt(history)        — derives the user message for the
//                                     SDK call from the thread's history.
//   composeSystemBlocks(args)       — assembles the cacheable system
//                                     blocks (selfProfile, conventions,
//                                     index, hot pages, systemBody) with
//                                     the doc body pinned past the SDK's
//                                     cache boundary.
//
// Both helpers are pure — they don't read store state or hit the
// network. The engine (chat/index.ts) does the I/O (ctx assembly,
// view doc extraction) and feeds the results in.

import type { ChatTurn } from '@/chat/types'
import { DOC_CHAR_CAP, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from './types'

/** Derive the user prompt for the current SDK call from the thread
 * history. SDK session resume keeps prior turns server-side — we
 * only send the latest user message. Older revisions concatenated
 * a transcript here; that broke prompt-cache reuse and was
 * explicitly flagged as a temporary bridge. */
export function buildUserPrompt(history: ChatTurn[]): string {
  const turns = history.filter((t) => t.content.trim().length > 0)
  if (turns.length === 0) return ''
  return turns[turns.length - 1].content
}

/** Slice the doc text down to {@link DOC_CHAR_CAP} characters from
 * the front. The cap is a budget guard against long docs blowing
 * past the model's context window — the LLM still gets the top of
 * the document, which is where the user is usually editing. */
export function truncateDocForPrompt(docText: string): string {
  return docText.length > DOC_CHAR_CAP ? docText.slice(0, DOC_CHAR_CAP) : docText
}

export interface SystemBlocksArgs {
  /** Doc text already capped via {@link truncateDocForPrompt}. */
  docForPrompt: string
  /** Caller-chosen system prompt body (FREE_CHAT_PROMPT by default). */
  systemBody: string
  /** Result of `assembleContext({ mode: 'chat' })` — the three blocks
   * the chat path actually injects. The wiki index + hot-page
   * bodies that the previous shape carried are intentionally absent:
   * the Karpathy / Claude Code pattern has the LLM fetch those via
   * Read / Glob / Grep when (and only when) a turn warrants it. */
  ctx: {
    selfProfile: string
    conventions: string
    claudeMd: string
  }
  /** When true (default for free chat) the document body is appended
   * past the SDK's cache boundary so it doesn't poison the cache key.
   * Slash commands that already embed `{{document}}` in their body
   * pass false to avoid the document showing up twice. */
  appendDocument: boolean
}

/** Compose the system prompt as a `string | string[]`.
 *
 * Anchor ordering by cache stability:
 *   prefix (stable):   selfProfile → conventions → claudeMd → systemBody
 *   suffix (dynamic):  document
 *
 * `selfProfile` sits at the very top — it changes only when the user
 * edits the profile or the ingest LLM accepts a proposal targeting
 * `wiki:profile`. `conventions` is the user's vault-specific rules
 * page; rarely edited but user-owned. `claudeMd` is the Karpathy /
 * Claude Code schema document — vault layout, operations, tool
 * usage. The three blocks are all eligible for prompt caching.
 * `systemBody` (FREE_CHAT_PROMPT) is the shortest, most app-
 * specific framing. The document changes every keystroke so we pin
 * it after the SDK's cache boundary.
 *
 * The return type is `string | string[]`:
 *   - `string[]` with a {@link SYSTEM_PROMPT_DYNAMIC_BOUNDARY} sentinel
 *     when there's a dynamic suffix (the document).
 *   - `string[]` without the sentinel when the prefix has multiple
 *     blocks but no dynamic suffix (slash commands embedding their
 *     own doc).
 *   - bare `string` when the prefix is just `systemBody` — keeps the
 *     SDK call simple and matches the pre-multi-block shape. */
export function composeSystemBlocks(args: SystemBlocksArgs): string | string[] {
  const { docForPrompt, systemBody, ctx, appendDocument } = args
  const prefix: string[] = []
  if (ctx.selfProfile) {
    prefix.push(`--- SELF PROFILE ---\n${ctx.selfProfile}`)
  }
  if (ctx.conventions) prefix.push(ctx.conventions)
  if (ctx.claudeMd) prefix.push(ctx.claudeMd)
  prefix.push(systemBody)

  if (appendDocument) {
    return [...prefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, `--- DOCUMENT ---\n${docForPrompt}`]
  }
  // prefix always contains systemBody; >1 means at least one context
  // section actually fired.
  if (prefix.length > 1) return prefix
  return systemBody
}

/** Pick between the `sessionId` (first turn) and `resume` (subsequent)
 * SDK options so we don't try to resume a session that doesn't exist
 * yet, and don't try to create one that does.
 *
 * Authoritative source: ThreadMeta.sessionStarted, plumbed through
 * `sessionStarted`. Once true, every subsequent run for the thread
 * must resume — including Regenerate, which deletes the prior
 * assistant turn and would otherwise look like a fresh send.
 *
 * Fallback: the legacy history-shape heuristic, used for threads
 * created before the flag existed (sessionStarted absent on the
 * meta). */
export function shouldResumeSession(
  history: ChatTurn[] | undefined,
  sessionStarted: boolean | undefined,
): boolean {
  if (sessionStarted) return true
  if (!history) return false
  return history.some((t) => t.role === 'assistant')
}
