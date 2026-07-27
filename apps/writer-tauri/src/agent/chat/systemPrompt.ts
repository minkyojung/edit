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

import type { Attachment, ChatTurn } from '@/chat/types'
import { DOC_CHAR_CAP, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from './types'

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
  // A turn is "real" if it has typed text OR a pasted-text chip (a pasted-only
  // send has empty content but must still become the prompt).
  const pastedOf = (t: ChatTurn) =>
    (t.attachments ?? [])
      .filter((a): a is Extract<Attachment, { type: 'pasted' }> => a.type === 'pasted')
      .map((a) => a.content)
      .join('\n\n')
  const turns = history.filter(
    (t) => !t.synthetic && (t.content.trim().length > 0 || pastedOf(t).length > 0),
  )
  if (turns.length === 0) return ''
  const last = turns[turns.length - 1]
  // Reattach pasted text (kept off the visible message as a chip) so the model
  // still receives it, prepended like the composer used to fold it in.
  const pasted = pastedOf(last)
  if (!pasted) return last.content
  return last.content.trim() ? `${pasted}\n\n${last.content}` : pasted
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
    /** The bounded profile SUMMARY (Background carved out). */
    selfProfile: string
    /** Vault-relative path of the profile page — set only when its
     * `## Background` zone has content, so the block appends a pointer telling
     * the model to Read it on demand. Optional for callers that don't split. */
    selfProfileBackgroundPath?: string | null
    claudeMd: string
    preferences: string
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
  /** The vault-relative knowledge-base folder (settings `knowledgeBaseFolder`,
   * e.g. "wiki"). Injected so the model files durable synthesized knowledge
   * here and treats it as authoritative over any folder named in the CLAUDE.md
   * schema (the setting is what the user actually chose). Stable → cacheable
   * prefix. */
  knowledgeBaseFolder?: string | null
  /** When true (default for free chat) the document body is appended
   * past the SDK's cache boundary so it doesn't poison the cache key.
   * Slash commands that already embed `{{document}}` in their body
   * pass false to avoid the document showing up twice. */
  appendDocument: boolean
  /** Vault-relative path of a non-markdown file open in the FileViewer (PDF,
   * image, audio, …). Unlike `currentFilePath`, there's no text body to inject
   * — the model is told to Read the path on demand to interpret it. */
  viewingFilePath?: string | null
  /** Text the user has selected in the editor when sending a free-chat turn.
   * Injected as a high-salience `--- SELECTION ---` block so "explain this" /
   * "rewrite this" resolve to the selection, not the whole document. Slash
   * commands handle selection via `{{selection}}` and don't pass this. */
  selectionText?: string | null
  /** Today's date as local `YYYY-MM-DD` (from `todayLocalDate()`). Injected
   * past the cache boundary so the model can resolve "today" / "today's
   * daily note" without guessing — and so the daily-changing value never
   * busts the cacheable prefix. */
  today?: string
}

/** Compose the system prompt as a `string | string[]`.
 *
 * Anchor ordering by cache stability (most-stable → most-mutable):
 *   prefix (stable):   systemBody(persona) → claudeMd → folder blocks →
 *                      SELF PROFILE → PREFERENCES
 *   suffix (dynamic):  today → viewing file → selection → document
 *
 * `systemBody` (FREE_CHAT_PROMPT) and `claudeMd` (the Karpathy / Claude Code
 * schema — vault layout, operations, tool usage, conventions) are app-static,
 * so they lead. The GROWING per-user blocks (SELF PROFILE, PREFERENCES — the
 * compound loop appends to these) sit LAST in the cacheable prefix so an
 * append invalidates only the small trailer, not the static core. The profile
 * block itself carries only the bounded summary; its unbounded `## Background`
 * loads on demand via a pointer (see the SELF PROFILE assembly below). The
 * document changes every keystroke so we pin it after the SDK's cache boundary.
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
    knowledgeBaseFolder,
    appendDocument,
    viewingFilePath,
    selectionText,
    today,
  } = args
  const prefix: string[] = []
  // Blocks are ordered MOST-STABLE → MOST-MUTABLE so the SDK prompt cache can
  // reuse the longest possible prefix. A change anywhere in the cached prefix
  // invalidates every byte below it, so the app-static blocks lead (persona,
  // then the CLAUDE.md schema), the vault-static folder blocks follow, and the
  // per-user GROWING blocks (self-profile, preferences) sit LAST — appended
  // below, just before the dynamic boundary. That way a fact appended by the
  // compound loop (reject → preference, profile facts) re-writes only the small
  // trailer, not the large static core above it.
  //
  // Native command runs (slash-command intake) carry their brain in the USER
  // turn, so they pass an empty systemBody — skip it rather than push a blank
  // block. Chat always has a non-empty persona, so this is a no-op there.
  if (systemBody) prefix.push(systemBody)
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
  // Name the knowledge-base folder — where durable, synthesized knowledge
  // (entity / topic / concept pages) lives. This is the user's actual setting,
  // so it's AUTHORITATIVE over any folder the CLAUDE.md schema names. Stable →
  // cacheable prefix.
  if (knowledgeBaseFolder) {
    prefix.push(
      `--- KNOWLEDGE BASE ---\n` +
        `The knowledge base is \`${knowledgeBaseFolder}/\` — the home for durable, ` +
        `synthesized knowledge (the entity / topic / concept pages you own and keep ` +
        `coherent). When you file lasting knowledge from a capture or a chat, write or ` +
        `update pages HERE. This is the user's configured location: if the CLAUDE.md ` +
        `schema above names a different folder for the knowledge base, THIS setting wins.`,
    )
  }

  // Per-user GROWING blocks last (see the ordering note at the top of the
  // prefix build): profile + preferences accrue over time, so keeping them at
  // the tail of the cacheable prefix means an append only invalidates this
  // trailer, not the static core above.
  //   - SELF PROFILE: facts about who the user is (from Profile.md).
  //   - PREFERENCES: the "how you should act" rules (from _system/preferences.md)
  //     — the per-user slice the CLAUDE.md schema points at. Empty until the
  //     user sets any, in which case the block is dropped.
  // Self-profile: the bounded summary always-on, the growing Background loaded
  // on demand. Render the block when EITHER is present — an all-Background
  // profile has an empty summary but still needs its pointer, so guarding on
  // the summary alone would silently drop it.
  if (ctx.selfProfile || ctx.selfProfileBackgroundPath) {
    const parts: string[] = []
    if (ctx.selfProfile) parts.push(ctx.selfProfile)
    if (ctx.selfProfileBackgroundPath) {
      const abs = vaultRoot
        ? `${vaultRoot}/${ctx.selfProfileBackgroundPath}`
        : ctx.selfProfileBackgroundPath
      parts.push(
        `Fuller background facts about the user (history, ongoing projects, ` +
          `relationships, past events) live in the \`## Background\` section of ` +
          `their profile page at \`${abs}\`. That section is kept OUT of this ` +
          `prompt to stay lean. When a task needs a specific personal fact the ` +
          `summary above doesn't cover, Read that file first — don't guess or ` +
          `claim you don't know without checking.`,
      )
    }
    prefix.push(`--- SELF PROFILE ---\n${parts.join('\n\n')}`)
  }
  if (ctx.preferences) {
    prefix.push(`--- PREFERENCES ---\n${ctx.preferences}`)
  }

  // Dynamic suffix — pinned past the SDK cache boundary because it changes
  // per turn.
  const dynamic: string[] = []
  if (today) {
    dynamic.push(
      `--- TODAY ---\nToday's date is ${today} (the user's local timezone). ` +
        `When the user says "today" / "the daily note", resolve it against this date.`,
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
  // NOTE: the open note, @-mentioned files and attached files are NOT injected
  // here. They belong to a specific turn, but a persistent thread freezes its
  // system prompt at the first turn's value (the SDK has no setSystemPrompt),
  // so anything added on a later turn would never reach the model through this
  // channel. They ride the USER message instead — see currentNoteBlock /
  // attachedFilesBlock / referencedFilesBlock, built into the prompt in runChat.
  if (appendDocument) dynamic.push(`--- DOCUMENT ---\n${docForPrompt}`)

  if (dynamic.length > 0) {
    return [...prefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, ...dynamic]
  }
  // A single-element prefix means only systemBody fired (chat with no context
  // blocks) — return it bare so the SDK caches a plain string. Anything else
  // (CLAUDE.md, workspace, etc. — always present for vault runs) returns the
  // block array. `systemBody` is '' only for native command runs, which always
  // have those blocks, so the bare fallback never yields an empty prompt.
  if (prefix.length > 1) return prefix
  return systemBody
}

/** The `--- CURRENT NOTE ---` block naming the note the user is looking at.
 *
 * Rides the USER message, NOT the system prompt. A persistent thread resolves
 * its system prompt ONCE, at the first turn (the SDK has no setSystemPrompt —
 * `sidecar/src/server.mjs` builds thread options in `#ensureThread` and the
 * reuse path drops `params.systemPrompt`), so a note opened on a later turn
 * could never reach the model from there: the model kept answering about
 * whichever note the thread STARTED on. Every comparable product attaches the
 * active file to the user turn for the same reason.
 *
 * Three constraints shape the wording, and each one is load-bearing:
 *
 *  1. FACTUAL, NOT IMPERATIVE. Text framed as an out-of-band system command
 *     can trip the model's prompt-injection defenses once it sits in a user
 *     message (it would surface the block to the user instead of acting on
 *     it). So this states what is true; it doesn't issue orders.
 *  2. SELF-DATING. A session is append-only — there is no channel to revoke or
 *     replace an earlier injection, so every past turn's block stays in the
 *     history forever. "As of this message" makes a stale copy read as a
 *     historical fact rather than a competing present-tense claim.
 *  3. LATEST-WINS. Belt to (2)'s braces, and the same device Aider uses for
 *     its in-chat file bodies: name the ambiguity and resolve it explicitly
 *     rather than trying to prune the old copies.
 *
 * `body` is passed only when this thread hasn't already been shown this exact
 * content (see noteContextLedger) — the path is cheap enough to repeat every
 * turn, a full body is not.
 *
 * `bodyShownEarlier` distinguishes the two reasons a body can be absent, and
 * both statements have to stay true or the model will either re-Read something
 * it has or answer from a note it doesn't. It's absent-but-known when the
 * ledger says this thread already received it; it's absent-and-unknown when
 * some other channel owns the text this run (a slash command renders
 * `{{document}}` into its own prompt, so repeating it here would send the whole
 * note twice), in which case the block says nothing about content at all.
 */
export function currentNoteBlock(
  path: string,
  body?: string,
  bodyShownEarlier = false,
): string {
  if (!path) return ''
  const lines = [
    `--- CURRENT NOTE ---`,
    `As of this message, the user is looking at the note \`${path}\`. ` +
      `"this", "here", and "this note" refer to it when they don't name a file. ` +
      `They may still be asking about another note — this is where they are, not a limit on what they mean.`,
    `If an earlier message in this conversation named a different current note, that message is out of date. This one is current.`,
  ]
  if (body !== undefined) {
    lines.push(
      `Its content as of this message follows. Where an earlier message in this ` +
        `conversation shows a different version of this note, that version is stale ` +
        `and this one is accurate:\n\n${body}`,
    )
  } else if (bodyShownEarlier) {
    lines.push(`Its content was included earlier in this conversation and has not changed since.`)
  }
  return lines.join('\n')
}

/** The `--- ATTACHED FILES ---` block for files the user attached to a turn
 * (paperclip / drag / paste), written to the hidden `.octave/attachments/`
 * folder. Rendered into the USER message — NOT the system prompt — so it
 * travels with the turn it belongs to: a persistent thread freezes its system
 * prompt at the first turn, so attachments added on a later turn must ride the
 * user message to reach the model. Returns '' when there are no attachments. */
export function attachedFilesBlock(attachedFiles: string[]): string {
  if (!attachedFiles || attachedFiles.length === 0) return ''
  const list = attachedFiles.map((p) => `\`${p}\``).join('\n')
  return (
    `--- ATTACHED FILES ---\n` +
    `The user attached these files to THIS message. Before answering, Read ` +
    `each one — they are the subject of the request even if the message ` +
    `doesn't name them (Read ingests PDFs and images directly). Do not answer ` +
    `about their contents without reading them first:\n\n${list}`
  )
}

/** The `--- REFERENCED FILES ---` block for files the user @-mentioned in a
 * turn. When `body` is present (the note is open / loaded, so its in-memory
 * content is fresher than disk) it's injected inline; otherwise the model is
 * told to Read the path. Like {@link attachedFilesBlock}, this rides the USER
 * message so it reaches the model on the exact turn it was mentioned. Returns
 * '' when nothing was mentioned. */
export function referencedFilesBlock(mentionFiles: { path: string; body?: string }[]): string {
  if (!mentionFiles || mentionFiles.length === 0) return ''
  const blocks = mentionFiles.map((f) =>
    f.body
      ? `File \`${f.path}\` (current content — use this, it's fresher than disk):\n\n${f.body}`
      : `\`${f.path}\` — Read this exact path for its content.`,
  )
  return (
    `--- REFERENCED FILES ---\n` +
    `The user @-mentioned these files in their message. Treat them as ` +
    `attached context for this turn — use them before answering, even if ` +
    `the message doesn't name them again:\n\n${blocks.join('\n\n')}`
  )
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
