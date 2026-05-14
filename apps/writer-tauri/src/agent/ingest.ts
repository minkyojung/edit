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
import { useIngestStore } from '@/state/ingestStore'
import { isEffectivelyEmpty } from '@/lib/markdownText'
import { pickNewBlocks } from '@/lib/blockHash'
import {
  readWikiContext,
  readConventions,
  ensureConventionsWikiSlug,
  ensureIndexWikiSlug,
  readIndexContext,
} from '@/state/wikiService'

const PROOF_BASE_URL = 'http://localhost:4000'
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
  /** Type id of an existing wiki page to nest the new page under.
   * Used only with `suggestNewPage`. Uses the SAME format as
   * `target` (e.g. `wiki:custom-7nt...`) — picked from the WIKI
   * block headers the LLM sees (`[<type-id> — <title>]`). Strict
   * type-id lookup, no title fallback: the system prompt asks the
   * model to copy the id verbatim, and a miss degrades to root
   * creation (logged) so a typo doesn't silently land the page
   * somewhere unintended. System pages are filtered out at the
   * createCustomWikiPage layer too. */
  suggestNewPageParent?: string
  /** Markdown to append to the target page's body. */
  content: string
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

/** One summary line in `wiki:index` — Karpathy's index.md pattern.
 * The LLM emits one of these whenever a target page either gained
 * meaningful content or is being created (via `suggestNewPage`).
 * The apply layer keeps the index page deduplicated by `target`:
 * a fresh update for the same target replaces the existing line
 * instead of appending. */
export interface IndexUpdate {
  /** wiki:* type id of the page this summary describes. Must match
   * an existing wiki page or one being created via suggestNewPage
   * in the same ingest pass. */
  target: string
  /** One-line description of the page. Phase 1-B keeps the format
   * loose — typically "X about Y" or "Z 관련 페이지". Phase 2 may
   * standardize once we see what the model produces in practice. */
  summary: string
}

export interface IngestResult {
  /** Append-only edits the LLM thinks the wiki should reflect. */
  proposals: IngestProposal[]
  /** One-line summaries for `wiki:index`, one per touched page.
   * Empty when nothing meaningful changed. The apply layer
   * deduplicates by target — sending the same target's summary
   * twice in different ingest passes replaces, doesn't append. */
  indexUpdates: IndexUpdate[]
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

Always include "sourceQuote": the exact sentence (or short clause) from the new note that this proposal was derived from. Echo it verbatim — it's the user's audit trail for verifying the proposal landed in the right page. If the proposal aggregates several lines, quote the most representative one.

Cross-link: when a proposal's content mentions another wiki page that already exists in the WIKI block, wrap that page's title with double-brackets so it renders as a clickable link. Use the title exactly as it appears in the block header — \`[<type-id> — <title>]\` — for the inner text. Skip the link when the page being mentioned is the same one you're writing to (no self-links). Skip the link when no existing page matches the mention (don't invent links). Example: if "Alex" is the title of \`wiki:custom-9k4...\`, write \`Working with [[Alex]] on the project\`, not \`Working with Alex on the project\`. This applies to both \`target\`-bound and \`suggestNewPage\` proposals.

Nesting: when emitting \`suggestNewPage\`, optionally also emit \`suggestNewPageParent\` with the exact type id (same format as \`target\` — e.g. \`wiki:custom-7nt...\`) of an existing wiki page to file the new page under. Copy the id verbatim from a WIKI block header — \`[<type-id> — <title>]\` — never use the title or invent an id. If no existing page is a good fit, leave \`suggestNewPageParent\` null and the new page is created at the root (the user can move it later). The user's conventions page declares which top-level pages act as categories; respect that hierarchy. Never nest under a system page; system surfaces don't accept children. Ignored when the proposal uses \`target\` instead of \`suggestNewPage\` — moving an existing page is a separate workflow.

The INDEX block (above WIKI) is the current one-line summary of each wiki page. For every page you propose to modify (\`target\`) or create (\`suggestNewPage\`), also emit an "indexUpdates" entry with a short summary. The summary is one sentence describing what the page is *about*, not what just changed. Reuse the existing summary verbatim when the page's nature didn't really change — only emit an updated summary if the new content meaningfully shifts what the page is about. For \`suggestNewPage\` you must always provide a fresh summary since no line exists yet. Use the same target type id you used in proposals.

When you're done analyzing the note, call the \`submit_ingest_result\` tool **exactly once** with the structured result. Do not emit JSON in your text response — the tool is the only channel that lands in the wiki. Each proposal uses *either* \`target\` (existing page) *or* \`suggestNewPage\` (create a new page), never both. Example arguments:

{
  "proposals": [
    { "target": "wiki:custom-7ntdvj41", "content": "- Direct report", "sourceQuote": "Sarah is now reporting to me", "rationale": "added detail to existing entity" },
    { "suggestNewPage": "The Pragmatic Programmer", "suggestNewPageParent": "wiki:custom-bk44a1z9", "content": "- Software craftsmanship", "sourceQuote": "Started reading The Pragmatic Programmer this week", "rationale": "fits under existing Books category (wiki:custom-bk44a1z9)" }
  ],
  "indexUpdates": [
    { "target": "wiki:custom-7ntdvj41", "summary": "Direct reports and their roles" },
    { "target": "The Pragmatic Programmer", "summary": "Core ideas from The Pragmatic Programmer" }
  ],
  "logEntry": "## [2026-05-07] ingest | daily/2026-05-07: added Sarah's role; created The Pragmatic Programmer under Books"
}

For \`suggestNewPage\` proposals, the indexUpdates entry uses the proposed page name (the same string you put in \`suggestNewPage\`) as the target — the apply layer rewrites it to the real wiki type id after the page is created.

If you found nothing worth filing, still call the tool — but pass empty arrays for proposals and indexUpdates AND pass \`null\` (not a string) for logEntry. The host suppresses empty passes entirely so they don't pile up in wiki:log; sending a "nothing notable" string just wastes tokens. The pass is still recorded for diagnostics on the host side. A pass without a tool call is treated as malformed and discarded.

When you DO have something to file (proposals or indexUpdates is non-empty), the logEntry must be a single line summarizing what got filed — one entry per ingest, never per-block verdicts. "added Sarah's role; created Books page" is right; enumerating "block A: kept, block B: transient, block C: filed" is wrong. The log is for what happened, not what you considered.`

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

/** Read a doc's markdown body via the canonical proof-server route.
 * Returns '' on any failure so a single ingest never crashes — the
 * caller can decide whether empty input is worth running on. */
async function readDocMarkdown(slug: string): Promise<string> {
  try {
    const res = await fetch(
      `${PROOF_BASE_URL}/documents/${encodeURIComponent(slug)}`,
    )
    if (!res.ok) return ''
    const json = (await res.json()) as { markdown?: string }
    const md = (json.markdown ?? '').trim()
    if (isEffectivelyEmpty(md)) return ''
    return md
  } catch {
    return ''
  }
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
    suggestNewPageParent?: string
    content: string
    rationale?: string
    sourceQuote?: string
  }>
  indexUpdates: Array<{ target: string; summary: string }>
  logEntry: string | null
}

interface ParsedIngest {
  proposals: IngestProposal[]
  indexUpdates: IndexUpdate[]
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
 *   - `suggestNewPageParent` only applies when creating a new page;
 *     drop it when the proposal already targets an existing page.
 *   - `indexUpdates` pointing at a system page (conventions / log /
 *     index) means the model hallucinated the routing — those pages
 *     have their own channels, never a target-style summary line.
 *
 * Whitespace trimming for free-form strings stays here too —
 * harmless and keeps the apply layer free of "is this empty?" gymnastics. */
function sanitizeIngestResult(input: IngestToolInput): ParsedIngest {
  const SYSTEM_TARGETS = new Set([
    'system:index',
    'system:log',
    'system:conventions',
  ])

  const proposals: IngestProposal[] = []
  for (const p of input.proposals) {
    const target = p.target?.trim() || undefined
    const suggestNewPage = p.suggestNewPage?.trim() || undefined
    if (!target && !suggestNewPage) continue
    const suggestNewPageParent =
      !target && p.suggestNewPageParent?.trim()
        ? p.suggestNewPageParent.trim()
        : undefined
    proposals.push({
      ...(target ? { target } : { suggestNewPage: suggestNewPage! }),
      ...(suggestNewPageParent ? { suggestNewPageParent } : {}),
      content: p.content,
      rationale: p.rationale,
      sourceQuote: p.sourceQuote?.trim() || undefined,
    })
  }

  const indexUpdates: IndexUpdate[] = []
  for (const u of input.indexUpdates) {
    const target = u.target.trim()
    const summary = u.summary.trim()
    if (!target || !summary) continue
    if (SYSTEM_TARGETS.has(target)) continue
    indexUpdates.push({ target, summary })
  }

  const logEntry = input.logEntry?.trim() || null

  return { proposals, indexUpdates, logEntry }
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

  const fullMarkdown = await readDocMarkdown(noteSlug)
  if (!fullMarkdown) {
    return {
      proposals: [],
      indexUpdates: [],
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
      indexUpdates: [],
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
  // Seed the index page on first need; readIndexContext feeds the
  // current summary lines into the prompt so the LLM can decide
  // whether to update or leave each page's summary alone. Empty
  // body means "no summaries yet" — buildPrompt skips the block.
  await ensureIndexWikiSlug()
  const indexSnapshot = await readIndexContext()
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
      indexUpdates: [],
      logEntry: null,
      raw: outcome.text,
      malformed: true,
      ingestedHashes: [],
    }
  }
  const { proposals, indexUpdates, logEntry } = sanitizeIngestResult(
    outcome.toolInput,
  )
  console.log('[ingest:producer] tool result accepted', {
    proposals: proposals.length,
    indexUpdates: indexUpdates.length,
    logEntry: !!logEntry,
    targets: proposals.map((p) => p.target ?? `new:${p.suggestNewPage}`),
  })
  return {
    proposals,
    indexUpdates,
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
