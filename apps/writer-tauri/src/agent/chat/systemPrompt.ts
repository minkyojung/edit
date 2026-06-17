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
import { DOC_CHAR_CAP, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, type VizEditTarget } from './types'

/** Derive the user prompt for the current SDK call from the thread
 * history. SDK session resume keeps prior turns server-side — we
 * only send the latest user message. Older revisions concatenated
 * a transcript here; that broke prompt-cache reuse and was
 * explicitly flagged as a temporary bridge. */
export function buildUserPrompt(history: ChatTurn[]): string {
  // `synthetic` turns (e.g. the AskUserQuestion answer bubble) are display-
  // only — the model already received that answer via the tool result, so
  // they must never become the prompt (Regenerate would otherwise re-send
  // the chosen answer text as a fresh question).
  const turns = history.filter((t) => !t.synthetic && t.content.trim().length > 0)
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
    working: string
    agentMemory: string
  }
  /** When true (default for free chat) the document body is appended
   * past the SDK's cache boundary so it doesn't poison the cache key.
   * Slash commands that already embed `{{document}}` in their body
   * pass false to avoid the document showing up twice. */
  appendDocument: boolean
  /** Vault-relative path of the note the user is currently viewing (orientation
   * context, not a constraint). Resolves deictic references ("this note", "여기")
   * to the open file by default while leaving the model free to act on others. */
  currentFilePath?: string | null
  /** Vault-relative path of a non-markdown file open in the FileViewer (PDF,
   * image, audio, …). Unlike `currentFilePath`, there's no text body to inject
   * — the model is told to Read the path on demand to interpret it. */
  viewingFilePath?: string | null
  /** When set, a high-salience block naming the visualization being edited
   * (id + current spec) is pinned past the cache boundary, instructing the
   * model to apply changes via the edit_visualization tool. */
  vizEditTarget?: VizEditTarget
  /** Today's date as local `YYYY-MM-DD` (from `todayLocalDate()`). Injected
   * past the cache boundary so the model can resolve "today" / "today's
   * daily note" without guessing — and so the daily-changing value never
   * busts the cacheable prefix. */
  today?: string
}

/** Compose the system prompt as a `string | string[]`.
 *
 * Anchor ordering by cache stability:
 *   prefix (stable):   selfProfile → conventions → claudeMd → working → systemBody
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
  const {
    docForPrompt,
    systemBody,
    ctx,
    appendDocument,
    currentFilePath,
    viewingFilePath,
    vizEditTarget,
    today,
  } = args
  const prefix: string[] = []
  if (ctx.selfProfile) {
    prefix.push(`--- SELF PROFILE ---\n${ctx.selfProfile}`)
  }
  if (ctx.conventions) prefix.push(ctx.conventions)
  if (ctx.claudeMd) prefix.push(ctx.claudeMd)
  // Working memory sits after the stable trio and before systemBody: it
  // changes more often than profile/conventions/CLAUDE.md, so keeping it
  // late in the prefix means a working-memory edit only re-tokenizes from
  // here on — the cached stable prefix above stays intact.
  if (ctx.working) prefix.push(`--- WORKING MEMORY ---\n${ctx.working}`)
  // Agent (role) long-term memory sits alongside working memory — both
  // fast-changing and late in the prefix, so a memory write only
  // re-tokenizes from here on and the cached stable prefix stays intact.
  if (ctx.agentMemory) prefix.push(`--- AGENT MEMORY ---\n${ctx.agentMemory}`)
  prefix.push(systemBody)

  // Dynamic suffix — pinned past the SDK cache boundary because it changes
  // per turn. The viz-edit block comes before the document so it reads as the
  // immediate task.
  const dynamic: string[] = []
  if (today) {
    dynamic.push(
      `--- TODAY ---\nToday's date is ${today} (the user's local timezone). ` +
        `When the user says "today" / "the daily note", resolve it against this date.`,
    )
  }
  if (vizEditTarget) {
    dynamic.push(
      `--- VISUALIZATION TO EDIT ---\n` +
        `The user is editing the visualization already in the document with id "${vizEditTarget.id}". ` +
        `Apply the user's request by calling the edit_visualization tool with chartId "${vizEditTarget.id}" ` +
        `and the FULL updated tree as root. Do NOT write a \`\`\`chart fence or any HTML for this edit, ` +
        `and preserve data you weren't asked to change.\n\nCurrent spec:\n${vizEditTarget.source}`,
    )
  }
  if (currentFilePath) {
    dynamic.push(
      `--- CURRENT FILE ---\n` +
        `The note the user is currently viewing is \`${currentFilePath}\`. When they say ` +
        `"this", "여기", "this note", or ask to edit / rewrite / add without naming a file, ` +
        `they mean THIS note by default — target it with your edit tools. You may still read ` +
        `or edit other notes via your tools when the request clearly calls for it (a different ` +
        `note, a new note, a linked one).`,
    )
  }
  if (viewingFilePath) {
    dynamic.push(
      `--- VIEWING FILE ---\n` +
        `The user is currently viewing the file \`${viewingFilePath}\` (a non-markdown ` +
        `file — e.g. a PDF, image, or audio). It is NOT a wiki note: there is no body ` +
        `text in this prompt for it. When they say "this", "this file", "여기", or ask ` +
        `you to summarize / explain / analyze without naming a file, they mean THIS file. ` +
        `Use the Read tool on that exact path to open and interpret it (Read ingests PDFs ` +
        `and images directly). Treat it as read-only — don't try to edit it.`,
    )
  }
  if (appendDocument) dynamic.push(`--- DOCUMENT ---\n${docForPrompt}`)

  if (dynamic.length > 0) {
    return [...prefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, ...dynamic]
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
