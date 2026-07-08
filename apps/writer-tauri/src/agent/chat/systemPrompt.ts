// Prompt assembly for the chat runner. Two surfaces:
//
//   buildUserPrompt(history)        — derives the user message for the
//                                     SDK call from the thread's history.
//   composeSystemBlocks(args)       — assembles the cacheable system
//                                     blocks (selfProfile, claudeMd,
//                                     systemBody) with the doc body
//                                     pinned past the SDK's cache
//                                     boundary.
//
// Both helpers are pure — they don't read store state or hit the
// network. The engine (chat/index.ts) does the I/O (ctx assembly,
// view doc extraction) and feeds the results in.

import type { ChatTurn, FileAttachment } from '@/chat/types'
import { DOC_CHAR_CAP, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, type VizEditTarget } from './types'

type TextBlock = { type: 'text'; text: string }
type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
type DocumentBlock = { type: 'document'; source: { type: 'base64'; media_type: string; data: string } }
type ContentBlock = TextBlock | ImageBlock | DocumentBlock

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

/** Build the user message content for the SDK call. When attachments are
 * present, returns a ContentBlock[] so the model receives both the text and
 * the files; otherwise falls back to a plain string to keep the common path
 * clean. The sidecar's makeInput yields this as MessageParam.content, which
 * the Anthropic SDK accepts as either form. */
export function buildUserContent(
  history: ChatTurn[],
  attachments?: FileAttachment[],
): string | ContentBlock[] {
  const text = buildUserPrompt(history)
  if (!attachments || attachments.length === 0) return text

  const blocks: ContentBlock[] = [{ type: 'text', text }]
  for (const att of attachments) {
    // data URLs are "data:<mediaType>;base64,<data>" — strip the prefix.
    const base64 = att.dataUrl.split(',')[1] ?? ''
    if (att.mediaType.startsWith('image/')) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: att.mediaType, data: base64 } })
    } else {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: att.mediaType, data: base64 } })
    }
  }
  return blocks
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
    claudeMd: string
  }
  /** Absolute path of the vault root. The model's file tools (Read/Glob/Grep/the
   * propose_* edit tools) take absolute paths, but a custom string systemPrompt
   * doesn't carry the SDK preset's working-directory `<env>` block — so without
   * this the model GUESSES the root on its first Read (`/Users/.../second-brain/…`)
   * and fails until the tool error reveals the real cwd. Pinned in the STATIC,
   * cacheable prefix (it's stable for the whole session, so it never busts cache). */
  vaultRoot?: string | null
  /** The vault-relative capture folder (settings `defaultNoteFolder`, e.g.
   * "inbox"). Injected so the model knows quick captures land there and that
   * it's the staging area to route notes OUT of — not a permanent home. Stable
   * for the session → sits in the cacheable prefix. */
  captureFolder?: string | null
  /** When true (default for free chat) the document body is appended
   * past the SDK's cache boundary so it doesn't poison the cache key.
   * Slash commands that already embed `{{document}}` in their body
   * pass false to avoid the document showing up twice. */
  appendDocument: boolean
  /** Vault-relative path of the note the user is currently viewing (orientation
   * context, not a constraint). Resolves deictic references ("this note", "here")
   * to the open file by default while leaving the model free to act on others. */
  currentFilePath?: string | null
  /** Vault-relative path of a non-markdown file open in the FileViewer (PDF,
   * image, audio, …). Unlike `currentFilePath`, there's no text body to inject
   * — the model is told to Read the path on demand to interpret it. */
  viewingFilePath?: string | null
  /** Text the user has selected in the editor when sending a free-chat turn.
   * Injected as a high-salience `--- SELECTION ---` block so "explain this" /
   * "rewrite this" resolve to the selection, not the whole document. Slash
   * commands handle selection via `{{selection}}` and don't pass this. */
  selectionText?: string | null
  /** Files the user @-mentioned in the composer, rendered in a
   * `--- REFERENCED FILES ---` block. When `body` is present (the note is open
   * / loaded, so its in-memory content is fresher than disk) it's injected
   * inline; otherwise the model is told to Read the path. */
  mentionFiles?: { path: string; body?: string }[]
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
 *   prefix (stable):   selfProfile → claudeMd → systemBody
 *   suffix (dynamic):  document
 *
 * `selfProfile` sits at the very top — it changes only when the user
 * edits the profile or the ingest LLM accepts a proposal targeting
 * `wiki:profile`. `claudeMd` is the Karpathy / Claude Code schema
 * document — vault layout, operations, tool usage, conventions (the
 * user's vault-specific rules now live inside it). Both blocks are
 * eligible for prompt caching. `systemBody` (FREE_CHAT_PROMPT) is the
 * shortest, most app-specific framing. The document changes every
 * keystroke so we pin
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
    vaultRoot,
    captureFolder,
    appendDocument,
    currentFilePath,
    viewingFilePath,
    selectionText,
    mentionFiles,
    vizEditTarget,
    today,
  } = args
  const prefix: string[] = []
  // App-static persona first so it forms the longest cache-stable prefix: it
  // ships with the binary and never changes on a vault switch, whereas the
  // self-profile and CLAUDE.md schema below are per-vault and swappable. Putting
  // the invariant block first means switching vaults only invalidates the cache
  // from the profile byte onward, not the persona above it.
  // Native routine runs (slash-command intake) carry their brain in the USER
  // turn, so they pass an empty systemBody — skip it rather than push a blank
  // block. Chat always has a non-empty persona, so this is a no-op there.
  if (systemBody) prefix.push(systemBody)
  if (ctx.selfProfile) {
    prefix.push(`--- SELF PROFILE ---\n${ctx.selfProfile}`)
  }
  if (ctx.claudeMd) prefix.push(ctx.claudeMd)
  // Ground the model's file tools in the real vault root (stable → stays in the
  // cacheable prefix). Without it the first Read guesses a wrong absolute path.
  if (vaultRoot) {
    prefix.push(
      `--- WORKSPACE ---\n` +
        `The vault root is \`${vaultRoot}\`. Every note lives under it; build absolute ` +
        `file paths from this root (e.g. \`${vaultRoot}/inbox/Note.md\`). Do NOT guess a ` +
        `different base directory.`,
    )
  }
  // Name the capture folder so the model treats it as a staging area, not a
  // home: quick captures land here, and filing/organizing means moving notes
  // OUT of it into the folder that fits. Stable → cacheable prefix.
  if (captureFolder) {
    prefix.push(
      `--- CAPTURE FOLDER ---\n` +
        `The capture folder is \`${captureFolder}/\` — where quick, unsorted notes land. ` +
        `Treat it as a staging inbox, NOT a permanent home: when you file or organize, ` +
        `move a note OUT of \`${captureFolder}/\` into the folder that best fits it (per the ` +
        `CLAUDE.md rules above). Don't route notes back into \`${captureFolder}/\`.`,
    )
  }

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
        `"this", "here", "this note", or ask to edit / rewrite / add without naming a file, ` +
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
        `text in this prompt for it. When they say "this", "this file", "here", or ask ` +
        `you to summarize / explain / analyze without naming a file, they mean THIS file. ` +
        `Use the Read tool on that exact path to open and interpret it (Read ingests PDFs ` +
        `and images directly). Treat it as read-only — don't try to edit it.`,
    )
  }
  if (selectionText && selectionText.trim()) {
    dynamic.push(
      `--- SELECTION ---\n` +
        `The user has selected this passage in the document. When they say "this", ` +
        `"here", "this part", or ask to explain / rewrite / fix without naming a target, ` +
        `they mean THIS selection — focus on it (the full document follows for context):\n\n` +
        selectionText,
    )
  }
  if (mentionFiles && mentionFiles.length > 0) {
    const blocks = mentionFiles.map((f) =>
      f.body
        ? `File \`${f.path}\` (current content — use this, it's fresher than disk):\n\n${f.body}`
        : `\`${f.path}\` — Read this exact path for its content.`,
    )
    dynamic.push(
      `--- REFERENCED FILES ---\n` +
        `The user @-mentioned these files in their message. Treat them as ` +
        `attached context for this turn — use them before answering, even if ` +
        `the message doesn't name them again:\n\n${blocks.join('\n\n')}`,
    )
  }
  if (appendDocument) dynamic.push(`--- DOCUMENT ---\n${docForPrompt}`)

  if (dynamic.length > 0) {
    return [...prefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, ...dynamic]
  }
  // A single-element prefix means only systemBody fired (chat with no context
  // blocks) — return it bare so the SDK caches a plain string. Anything else
  // (CLAUDE.md, workspace, etc. — always present for vault runs) returns the
  // block array. `systemBody` is '' only for native routine runs, which always
  // have those blocks, so the bare fallback never yields an empty prompt.
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
