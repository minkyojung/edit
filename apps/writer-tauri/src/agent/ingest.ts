// Ingest engine — Karpathy-style "user writes notes, LLM maintains the
// wiki" pattern. One call:
//
//   const result = await runIngest(noteSlug)
//
// reads the note's markdown, snapshots every wiki page, asks Haiku
// what should change in the wiki to reflect the new note, and returns
// proposals WITHOUT applying them. Application (ydoc append) and the
// trigger (idle / doc-close) are separate concerns layered on top.
//
// PR 3-1 (this file): engine + console verification only.
// PR 3-2: idle trigger + sidebar review card + apply.
//
// Why a fresh sessionId per call: ingest is one-shot — there's no
// multi-turn history to resume. We want each ingest evaluated against
// the live wiki snapshot, not against a stale cached prefix.

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useDocsStore, isWikiDoc } from '@/state/docsStore'
import { useEditorViewStore } from '@/state/editorViewStore'
import { useIngestStore } from '@/state/ingestStore'
import { isEffectivelyEmpty } from '@/lib/markdownText'
import { pickNewBlocks } from '@/lib/blockHash'
import {
  readWikiContext,
  readConventions,
  ensureConventionsWikiSlug,
} from '@/state/wikiService'
import { getWikiIndex } from '@/state/wikiIndex'
import { getActiveVaultPath } from '@/state/settingsStore'
const INGEST_MODEL = 'claude-haiku-4-5-20251001'

/** A single proposed wiki edit. v1 = append-only (the LLM may not
 * modify or delete existing lines). Routing has two flavors:
 *
 *   • `target` — append to an existing wiki page by its type id.
 *   • `suggestNewPage` — no existing page fits; ask the system to
 *     create a new one with the given display name and stamp the
 *     content there. The apply layer creates the page eagerly and
 *     rewrites the proposal's target to the new doc's type id, so
 *     downstream code only ever sees `target`.
 *
 * Exactly one of `target` or `suggestNewPage` is expected. If both
 * are present validateParsed prefers `target` (less destructive
 * fallback); if neither, the proposal is rejected. */
export interface IngestProposal {
  /** wiki:* type id (e.g. 'wiki:entity', 'wiki:custom-7nt...'). */
  target?: string
  /** Display name for a brand-new page the LLM wants to create
   * because no existing page is a good home for this content. The
   * apply layer turns this into a real `wiki:custom-<id>` page. */
  suggestNewPage?: string
  /** Topic the bullets are about — e.g. a person's name, a book
   * title, a project. Used as the `### {entity}` sub-heading when
   * appending to an existing `target` page; ignored when creating
   * a `suggestNewPage` (the page title is the topic). */
  entity: string
  /** Bullet bodies the model wants to record under `entity`. Plain
   * text — no leading `-`, no nested markdown structure. The host
   * assembles the final `### {entity}\n- {b}\n...` shape at apply
   * time. Splitting `content: string` into this atomic shape is
   * what blocks the model from re-emitting page-level headers
   * (e.g. "## People") that doubled up on every accept. */
  bullets: string[]
  /** Short reason the LLM gave for proposing this. Optional. */
  rationale?: string
  /** The exact daily-line snippet this content was derived from,
   * echoed verbatim. Provenance: lets the user (and the review
   * card) see "where in my note did this fact come from?" — so
   * mis-routes (e.g. Alex content sent to a Chris page because
   * the LLM mismapped a name) are visible at a glance instead of
   * buried inside the wiki body. Optional because some proposals
   * legitimately stand on aggregated context, not a single line. */
  sourceQuote?: string
}

/** Assemble the markdown to insert for a proposal. Encapsulates the
 * one rule the new schema enforces: headings come from the host, not
 * the model. Used by both the new-page body builder and the in-page
 * accept flow so the two paths can't drift on formatting.
 *
 * `withEntityHeading`: include `### {entity}` above the bullets.
 * - target case (append to existing page): true — the entity heading
 *   groups bullets that came from the same ingest pass.
 * - suggestNewPage case (new page is born about this entity): false —
 *   the page title already carries the topic; a body-level heading
 *   would render redundantly under it.
 */
export function assembleProposalMarkdown(
  proposal: Pick<IngestProposal, 'entity' | 'bullets'>,
  options: { withEntityHeading: boolean },
): string {
  const bullets = proposal.bullets
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
    .map((b) => `- ${b}`)
    .join('\n')
  if (!bullets) return ''
  if (!options.withEntityHeading) return bullets
  return `### ${proposal.entity.trim()}\n${bullets}`
}

export interface IngestResult {
  /** Append-only edits the LLM thinks the wiki should reflect. */
  proposals: IngestProposal[]
  /** Pre-formatted log line for wiki:log, or null if nothing was
   * meaningful enough to log. Format follows Karpathy's convention:
   * `## [YYYY-MM-DD] <kind> | <summary>`. */
  logEntry: string | null
  /** Raw assistant text for debugging. Useful when JSON parsing
   * fails so we can see what the model actually returned. */
  raw: string
  /** True when the assistant emitted text but it didn't parse as
   * JSON. Caller can show a soft warning rather than treating as
   * a hard error. */
  malformed: boolean
  /** Full snapshot of the source note's block hashes at the moment
   * this pass ran. Caller persists into
   * ingestStore.ingestedBlockHashes so the next pass can filter
   * already-seen blocks out before reaching the LLM. Empty when
   * the pass short-circuited before reading the note (unknown
   * doc, empty body, etc.); callers should skip the persist call
   * in that case to avoid clobbering a valid prior snapshot. */
  ingestedHashes: string[]
}

/** Static, system-owned rules that never move into the user's
 * conventions page: safety invariants (append-only), the wire
 * format (JSON shape, target-id semantics, anchor field), and the
 * job description. Stylistic / shape conventions are NOT here —
 * those live in the user's `wiki:conventions` page and get
 * prepended to this prompt at call time, so the user can co-evolve
 * them without touching code. */
const SYSTEM_PROMPT_STATIC = `You maintain a personal wiki on the user's behalf. The user just wrote a note. Your job: identify any information in the note that should be reflected in the wiki, and propose append-only edits to the relevant wiki pages.

Invariants (do not violate):
- APPEND ONLY. Never propose modifying or deleting existing lines.
- Each proposal "target" is the wiki page's full \`type\` id (e.g. "wiki:custom-7nt..."). Take it verbatim from the WIKI block headers — do not invent ids.
- Each WIKI block header looks like \`[<type-id> — <title>]\`. Read each page's body to understand what shape it has and what kind of content belongs there. The user's conventions (above) guide the broad strokes; the page's own body is the ground truth for its current pattern.
- Always include a log entry summarizing what you did (or "nothing notable today" if proposals is empty).
- Each proposal is atomic: ONE \`entity\` (the topic name — a person, a book, a project) and a list of \`bullets\` (the facts about that entity). DO NOT emit page-level or sub-section headings inside bullets — the host assembles \`### {entity}\\n- {bullet}\` automatically. Bullets are plain text only: no leading \`-\`, no nested headings, no \`##\` or \`###\`.

Always include "sourceQuote": the exact sentence (or short clause) from the new note that this proposal was derived from. Echo it verbatim — it's the user's audit trail for verifying the proposal landed in the right page. If the proposal aggregates several lines, quote the most representative one.

Cross-link: when a bullet mentions another wiki page that already exists in the WIKI block, wrap that page's title with double-brackets so it renders as a clickable link. Use the title exactly as it appears in the block header — \`[<type-id> — <title>]\` — for the inner text. Skip the link when the page being mentioned is the same one you're writing to (no self-links — don't link \`entity\` from inside its own bullets either). Skip the link when no existing page matches the mention (don't invent links). Example: if "Alex" is the title of \`wiki:custom-9k4...\`, a bullet should read \`Working with [[Alex]] on the project\`, not \`Working with Alex on the project\`. This applies to both \`target\`-bound and \`suggestNewPage\` proposals.

The wiki is FLAT — every entity is its own page at the same level. Do not create category pages. Each fact about a person belongs on a page named after that person, not on a shared "People" page. Same for books, projects, concepts.

The INDEX block (above WIKI) is a system-maintained catalog of every wiki page — one line each, with title + one-line summary + backlink count. Treat it as read-only context: it tells you what pages exist and roughly what they're about so you can route proposals correctly and decide whether a \`suggestNewPage\` actually adds a new entity vs. duplicates one that's already there. Do NOT emit any structured update for the index — the host rebuilds it deterministically from page bodies + sidecar metadata.

When you're done analyzing the note, call the \`submit_ingest_result\` tool **exactly once** with the structured result. Do not emit JSON in your text response — the tool is the only channel that lands in the wiki. Each proposal uses *either* \`target\` (existing page) *or* \`suggestNewPage\` (create a new page), never both. Example arguments:

{
  "proposals": [
    { "target": "wiki:custom-7ntdvj41", "entity": "Sarah", "bullets": ["Now reports directly to me"], "sourceQuote": "Sarah is now reporting to me", "rationale": "added detail to existing entity" },
    { "suggestNewPage": "The Pragmatic Programmer", "entity": "The Pragmatic Programmer", "bullets": ["Software craftsmanship", "Started reading this week"], "sourceQuote": "Started reading The Pragmatic Programmer this week", "rationale": "new entity not in WIKI yet" }
  ],
  "logEntry": "## [2026-05-07] ingest | daily/2026-05-07: added Sarah's role; created The Pragmatic Programmer page"
}

If you found nothing worth filing, still call the tool — but pass an empty array for proposals AND pass \`null\` (not a string) for logEntry. The host suppresses empty passes entirely so they don't pile up in wiki:log; sending a "nothing notable" string just wastes tokens. The pass is still recorded for diagnostics on the host side. A pass without a tool call is treated as malformed and discarded.

When you DO have something to file (proposals is non-empty), the logEntry must be a single line summarizing what got filed — one entry per ingest, never per-block verdicts. "added Sarah's role; created Books page" is right; enumerating "block A: kept, block B: transient, block C: filed" is wrong. The log is for what happened, not what you considered.`

/** Compose the full system prompt. The user-editable conventions
 * page (Karpathy's CLAUDE.md pattern) is prepended so it shadows
 * any stylistic defaults — the user always has the last word on
 * how their wiki should grow. The static rules follow because they
 * encode wire-format invariants the model must not ignore even if
 * the user wrote something contradictory in conventions. */
/** Compose the system prompt as a cacheable string[] for the Agent
 * SDK. Items before any `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` are
 * treated as the cacheable prefix; we don't have a dynamic suffix
 * here (per-call data lives in the user prompt) so every block
 * gets cached.
 *
 * Block order matters for cache stability:
 *   1. STATIC_RULES + conventions  — operating rules
 *   2. WIKI catalog                — page bodies
 *   3. INDEX summary               — per-page one-liners
 *
 * Subsequent ingest calls with the same wiki state hit the cache
 * for ~90% of the prompt cost; only the user prompt (DATE + NEW
 * NOTE) is fresh per call. Moving WIKI and INDEX out of the user
 * prompt (where they used to live) is what unlocks the cache —
 * user prompts are never cached. */
function composeSystemPrompt(args: {
  wikiSnapshot: string
  indexSnapshot: string
  conventions: string
}): string[] {
  const trimmedConventions = args.conventions.trim()
  const rules = trimmedConventions
    ? `User-defined wiki conventions (read carefully — these reflect how the user wants their wiki to grow):\n\n${trimmedConventions}\n\n---\n\n${SYSTEM_PROMPT_STATIC}`
    : SYSTEM_PROMPT_STATIC

  const blocks: string[] = [rules]

  const wiki = args.wikiSnapshot.trim().length
    ? args.wikiSnapshot
    : '(no wiki pages yet — propose targets only if a clearly-named one is needed)'
  blocks.push(`--- WIKI ---\n${wiki}`)

  if (args.indexSnapshot.trim().length) {
    blocks.push(
      `--- INDEX (current — one summary line per wiki page) ---\n${args.indexSnapshot}`,
    )
  }

  return blocks
}

/** Build the per-call user prompt. Everything that changes on
 * every ingest pass (today's date, the note being analyzed) goes
 * here so the system-prompt cache keeps hitting. The wiki context
 * and conventions used to live here too; they moved into the
 * system prompt (composeSystemPrompt above) for cache reuse. */
function buildPrompt(args: {
  date: string
  noteLabel: string
  noteMarkdown: string
}): string {
  return [
    `DATE: ${args.date}`,
    '',
    `NEW NOTE (${args.noteLabel}):`,
    args.noteMarkdown,
  ].join('\n')
}

/** Read a doc's markdown body directly from the client side.
 *
 * Phase 3.A — replaced the previous proof-server round-trip. The
 * server's deriveMarkdownFromFragment crashes on our client's
 * Y.XmlFragment (`node.children.some` on a node without children),
 * so the server's `markdown` column stays empty no matter how much
 * the user types — and ingest was bailing on "source doc empty"
 * even for full daily notes.
 *
 * Strategy:
 *   - Active doc: use the live PM doc + Milkdown's serializer. The
 *     output is the same markdown Milkdown would round-trip back
 *     through its own parser, so the LLM sees the exact text the
 *     user authored (headings, lists, code, etc.).
 *   - Non-active doc: fall back to flat text from the Y.XmlFragment.
 *     This drops markdown structure (#-headings, bullet markers),
 *     but daily notes — the only kind ingest reads — are mostly
 *     prose, so the LLM still extracts entities/bullets fine.
 *     If we later need full markdown for non-active sources, we'd
 *     stand up an offscreen PM instance against the Y.Doc.
 *
 * Returns '' for missing handles or empty/whitespace-only content
 * so a single ingest never crashes — the caller decides whether
 * empty input is worth running on. */
function readDocMarkdown(slug: string): string {
  const docs = useDocsStore.getState()
  const handle = docs.handles[slug]
  if (!handle) return ''

  if (docs.activeSlug === slug) {
    const view = useEditorViewStore.getState().view
    const serializer = useEditorViewStore.getState().serializer
    if (view && serializer) {
      try {
        const md = serializer(view.state.doc).trim()
        if (isEffectivelyEmpty(md)) return ''
        return md
      } catch {
        // fall through to Y.Doc text fallback
      }
    }
  }

  const text = extractFragmentText(handle.ydoc.getXmlFragment('prosemirror'))
  const trimmed = text.trim()
  if (isEffectivelyEmpty(trimmed)) return ''
  return trimmed
}

/** Walk a Y.XmlFragment and collect text content as a flat string.
 * Used by readDocMarkdown's non-active-doc fallback. Markdown
 * structure is lost; for our daily-note workflow that's acceptable
 * (notes are mostly prose). */
function extractFragmentText(fragment: import('yjs').XmlFragment): string {
  const parts: string[] = []
  function walk(node: import('yjs').XmlElement | import('yjs').XmlText | import('yjs').XmlFragment | import('yjs').XmlHook): void {
    if ('toString' in node && typeof (node as { toString: () => string }).toString === 'function') {
      // XmlText 의 toString 은 자체 텍스트만. XmlElement/Fragment 은 자식
      // 트리 전체. 우리는 자식들의 텍스트만 합치고 싶으므로 element 는
      // 직접 순회.
    }
    const length = (node as { length?: number }).length
    if (typeof length !== 'number') return
    for (let i = 0; i < length; i++) {
      const child = (node as unknown as { get: (i: number) => unknown }).get(i)
      if (!child) continue
      if (typeof (child as { toString: () => string }).toString === 'function') {
        const text = String(child)
        // XmlElement 가 toString 호출 시 자식 합쳐서 반환하면 단락 사이에
        // 줄바꿈이 없음. paragraph 단위로 newline 삽입해야 LLM 이 단락
        // 구분 인식. 단순화: 모든 element 사이에 \n.
        parts.push(text)
        parts.push('\n')
      }
    }
    void walk
  }
  walk(fragment)
  return parts.join('')
}

/** Local-time YYYY-MM-DD. Pinned to local because "today's note"
 * follows the user's wall clock, not UTC. */
function todayLocalDate(): string {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/** Raw shape the sidecar relays from the model's
 * `submit_ingest_result` tool call. Field types mirror the zod
 * schema in sidecar/src/server.mjs — the SDK has already validated
 * shape by the time this lands, so the only work left is semantic
 * (sanitizeIngestResult below). */
interface IngestToolInput {
  proposals: Array<{
    target?: string
    suggestNewPage?: string
    /** Legacy field — accepted for backward compatibility with a
     * previous schema generation but ignored at sanitize time. Wiki
     * is now flat; nesting under a parent isn't a concept the model
     * needs to reason about. */
    suggestNewPageParent?: string
    entity: string
    bullets: string[]
    rationale?: string
    sourceQuote?: string
  }>
  logEntry: string | null
}

interface ParsedIngest {
  proposals: IngestProposal[]
  logEntry: string | null
}

/** Semantic filtering on top of the tool's structural validation.
 *
 * The zod schema guarantees field shape and required-ness, but a
 * few invariants are cross-field or domain-specific and can't be
 * expressed there:
 *
 *   - a proposal must have at least one of `target` / `suggestNewPage`;
 *     both empty means "nowhere to land", drop it.
 *   - when both are set, prefer `target` (less destructive — uses an
 *     existing page rather than spawning a new one).
 *   - `suggestNewPageParent` is now stripped — the wiki is flat,
 *     parent nesting isn't part of the data model.
 *
 * Whitespace trimming for free-form strings stays here too —
 * harmless and keeps the apply layer free of "is this empty?" gymnastics. */
function sanitizeIngestResult(input: IngestToolInput): ParsedIngest {
  const proposals: IngestProposal[] = []
  for (const p of input.proposals) {
    const target = p.target?.trim() || undefined
    const suggestNewPage = p.suggestNewPage?.trim() || undefined
    if (!target && !suggestNewPage) continue
    // p.suggestNewPageParent intentionally ignored — see file header.
    // Zod guarantees entity is a non-empty string and bullets is a
    // non-empty array, but the model can still ship whitespace-only
    // values inside those slots. Trim + filter here so the apply
    // layer never sees an entity that's just spaces or a bullet
    // that would render as a blank `-`. A proposal that ends up
    // with zero usable bullets is dropped — same policy the old
    // shape applied to empty `content`.
    const entity = p.entity.trim()
    const bullets = p.bullets
      .map((b) => b.trim())
      .filter((b) => b.length > 0)
    if (!entity || bullets.length === 0) continue
    proposals.push({
      ...(target ? { target } : { suggestNewPage: suggestNewPage! }),
      entity,
      bullets,
      rationale: p.rationale,
      sourceQuote: p.sourceQuote?.trim() || undefined,
    })
  }

  const logEntry = input.logEntry?.trim() || null

  return { proposals, logEntry }
}

interface ChatRunOutcome {
  /** Tool input from the model's `submit_ingest_result` call, or
   * null when the model didn't call the tool. Null counts as a
   * malformed pass: the LLM ignored the contract. */
  toolInput: IngestToolInput | null
  /** Any free-form assistant text. With the tool active the model
   * shouldn't say much (a brief acknowledgment at most), but we
   * still capture it for diagnostics when toolInput ends up null. */
  text: string
}

/** Wait for one chat run to complete on the chat sidecar. With the
 * `submit_ingest_result` tool enabled, the model's structured
 * output arrives via an `ingest:result` notification (relayed
 * through Rust as a Tauri event); free-form text deltas still
 * stream on `claude:event` and we accumulate them for diagnostics.
 * Either branch is sufficient to call the run "settled" — we
 * resolve on `claude:done` with whatever we captured. */
function awaitChatRun(runId: string): Promise<ChatRunOutcome> {
  return new Promise<ChatRunOutcome>((resolve, reject) => {
    let toolInput: IngestToolInput | null = null
    let assistantText = ''
    const unlistens: UnlistenFn[] = []
    let settled = false

    const cleanup = () => {
      while (unlistens.length > 0) {
        try {
          unlistens.pop()?.()
        } catch {
          /* listener already detached */
        }
      }
    }
    const settleOk = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ toolInput, text: assistantText })
    }
    const settleErr = (err: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    Promise.all([
      // The structured-output channel: sidecar relays the tool input
      // here when the model calls submit_ingest_result. We expect
      // at most one of these per run.
      listen<{ runId: string; input: IngestToolInput }>(
        'ingest:result',
        (e) => {
          if (e.payload.runId !== runId) return
          toolInput = e.payload.input
        },
      ),
      listen<{
        runId: string
        event: {
          type?: string
          event?: {
            type?: string
            delta?: { type?: string; text?: string }
          }
          message?: { content?: Array<{ type: string; text?: string }> }
        }
      }>('claude:event', (e) => {
        if (e.payload.runId !== runId) return
        const ev = e.payload.event
        if (ev?.type === 'stream_event') {
          const inner = ev.event
          if (
            inner?.type === 'content_block_delta' &&
            inner.delta?.type === 'text_delta' &&
            inner.delta.text
          ) {
            assistantText += inner.delta.text
          }
          return
        }
        if (ev?.type === 'assistant') {
          const blocks = ev.message?.content ?? []
          if (Array.isArray(blocks) && assistantText.length === 0) {
            for (const b of blocks) {
              if (b.type === 'text' && typeof b.text === 'string') {
                assistantText += b.text
              }
            }
          }
        }
      }),
      listen<{ runId: string; stopReason: string | null }>(
        'claude:done',
        (e) => {
          if (e.payload.runId !== runId) return
          settleOk()
        },
      ),
      listen<{ runId: string; code: string; message: string }>(
        'claude:error',
        (e) => {
          if (e.payload.runId !== runId) return
          settleErr(new Error(`${e.payload.code}: ${e.payload.message}`))
        },
      ),
      listen<{ mode: string }>('sidecar:died', (e) => {
        if (e.payload.mode !== 'chat') return
        settleErr(new Error('SIDECAR_DIED: chat sidecar crashed'))
      }),
    ])
      .then((registered) => unlistens.push(...registered))
      .catch((err) => settleErr(err))
  })
}

/** Run one ingest pass against the given note slug. Reads the note,
 * snapshots the wiki, calls Haiku, returns proposals (no apply).
 * Throws on transport / SDK errors. Returns malformed=true when the
 * model emitted text but it didn't parse — caller can decide whether
 * to retry or surface as a soft warning. */
export async function runIngest(noteSlug: string): Promise<IngestResult> {
  const known = useDocsStore
    .getState()
    .knownDocs.find((d) => d.slug === noteSlug)
  if (!known) throw new Error(`unknown doc: ${noteSlug}`)
  if (isWikiDoc(known)) {
    // Agent-managed pages (system:* meta surface + wiki:custom-*
    // content) are LLM output, not input — ingesting one would mean
    // asking the model to summarize itself. The trigger layer
    // enforces this too, but guard here so console testing can't
    // accidentally poison the wiki with self-echo.
    throw new Error(`refusing to ingest an agent-managed page: ${noteSlug}`)
  }

  const fullMarkdown = readDocMarkdown(noteSlug)
  if (!fullMarkdown) {
    return {
      proposals: [],
      logEntry: null,
      raw: '',
      malformed: false,
      ingestedHashes: [],
    }
  }

  // Block-hash filter: only forward blocks the LLM hasn't seen
  // before. This is the structural dedup guard — without it, the
  // same paragraph re-sent on a later pass would re-trigger
  // proposals the user already accepted, stamping duplicate rows
  // into the wiki. `allHashes` is the *full* current snapshot
  // (not just new ones); caller persists it so deletions and
  // edits both self-heal.
  const seen = new Set(
    useIngestStore.getState().ingestedBlockHashes[noteSlug] ?? [],
  )
  const { newBlocks, allHashes } = await pickNewBlocks(fullMarkdown, seen)
  if (newBlocks.length === 0) {
    console.log('[ingest:producer] no new blocks since last pass', {
      noteSlug,
      totalBlocks: allHashes.length,
    })
    return {
      proposals: [],
      logEntry: null,
      raw: '',
      malformed: false,
      // Return the current snapshot anyway — the caller persists
      // it to reflect deletions (any hash that disappeared from
      // the body falls out of the stored set).
      ingestedHashes: allHashes,
    }
  }
  const noteMarkdown = newBlocks.map((b) => b.text).join('\n\n')
  console.log('[ingest:producer] block filter', {
    noteSlug,
    new: newBlocks.length,
    total: allHashes.length,
  })

  const wikiSnapshot = await readWikiContext()
  // Seed the conventions page on first need so the user has
  // something to edit, then read its body to prepend onto the
  // system prompt. Failures degrade gracefully — empty conventions
  // means the static rules take over alone.
  await ensureConventionsWikiSlug()
  const conventions = await readConventions()
  // Tier 1 catalog — system-built from knownDocs + sidecars on
  // every wiki change (see state/wikiIndex.ts). The LLM gets a
  // deterministic snapshot of every wiki page's title + one-line
  // summary + backlink count without us paying tokens to have it
  // re-author the same content each pass. Empty string ⇒ no wiki
  // pages exist yet and buildPrompt skips the block.
  const indexSnapshot = await getWikiIndex()
  const noteLabel =
    known.type === 'daily' && known.date
      ? `daily/${known.date}`
      : known.title?.trim() || noteSlug

  const prompt = buildPrompt({
    date: todayLocalDate(),
    noteLabel,
    noteMarkdown,
  })
  const systemPrompt = composeSystemPrompt({
    wikiSnapshot,
    indexSnapshot,
    conventions,
  })

  const runId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()
  const finished = awaitChatRun(runId)
  await invoke('claude_chat_start', {
    args: {
      runId,
      model: INGEST_MODEL,
      systemPrompt,
      prompt,
      // Enable the structured-output tool. The sidecar registers
      // it as an MCP tool on the writer-relay server; the model
      // calls it exactly once with the full ingest result, which
      // we receive via the `ingest:result` event in awaitChatRun.
      relayTools: ['submit_ingest_result'],
      // Plumb the vault path for future read_page / search_wiki tools.
      // No effect today (those tools aren't in ingest's relayTools yet),
      // but keeping the parameter consistent across consumers means we
      // can opt into filesystem tools in a follow-up commit without
      // touching every call site.
      vaultPath: getActiveVaultPath() ?? undefined,
      effort: 'low',
      sessionId,
    },
  })
  const outcome = await finished
  if (!outcome.toolInput) {
    console.warn(
      '[ingest:producer] submit_ingest_result tool was not called',
      { textPreview: outcome.text.slice(0, 200) },
    )
    // Malformed pass: don't persist the hash snapshot — the LLM
    // never "consumed" these blocks, so leave the store as-is so
    // the next pass retries with the same content.
    return {
      proposals: [],
      logEntry: null,
      raw: outcome.text,
      malformed: true,
      ingestedHashes: [],
    }
  }
  const { proposals, logEntry } = sanitizeIngestResult(outcome.toolInput)
  console.log('[ingest:producer] tool result accepted', {
    proposals: proposals.length,
    logEntry: !!logEntry,
    targets: proposals.map((p) => p.target ?? `new:${p.suggestNewPage}`),
  })
  return {
    proposals,
    logEntry,
    raw: outcome.text,
    malformed: false,
    ingestedHashes: allHashes,
  }
}

/** Convenience for console testing: run ingest against today's
 * daily entry without having to look up the slug manually. Returns
 * null when there's no daily for today (shouldn't happen — bootstrap
 * always creates one — but handled so the console call never throws
 * a confusing TypeError). */
export async function ingestToday(): Promise<IngestResult | null> {
  const today = todayLocalDate()
  const known = useDocsStore
    .getState()
    .knownDocs.find((d) => d.type === 'daily' && d.date === today)
  if (!known) {
    console.warn('[ingest] no daily for today:', today)
    return null
  }
  return runIngest(known.slug)
}

/** Convenience for console testing: run ingest against the currently
 * active tab. Useful when the user is iterating on a specific note
 * and wants to see what the model would propose for it. */
export async function ingestActive(): Promise<IngestResult | null> {
  const slug = useDocsStore.getState().activeSlug
  if (!slug) {
    console.warn('[ingest] no active doc')
    return null
  }
  return runIngest(slug)
}

/** Dev-only handles so the engine is callable from the browser
 * console for prompt-tuning. The trigger and apply layers (PR 3-2)
 * will reach `runIngest` directly; this exposure is purely for
 * iteration during PR 3-1.
 *
 * Console usage:
 *   await __ingestToday()    // runs against today's daily
 *   await __ingestActive()   // runs against the active tab
 *   await __ingest('<slug>') // explicit slug
 */
if (import.meta.env.DEV) {
  const w = window as unknown as {
    __ingest: typeof runIngest
    __ingestToday: typeof ingestToday
    __ingestActive: typeof ingestActive
  }
  w.__ingest = runIngest
  w.__ingestToday = ingestToday
  w.__ingestActive = ingestActive
}
