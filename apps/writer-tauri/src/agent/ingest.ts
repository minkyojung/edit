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

The INDEX block (above WIKI) is the current one-line summary of each wiki page. For every page you propose to modify (\`target\`) or create (\`suggestNewPage\`), also emit an "indexUpdates" entry with a short summary. The summary is one sentence describing what the page is *about*, not what just changed. Reuse the existing summary verbatim when the page's nature didn't really change — only emit an updated summary if the new content meaningfully shifts what the page is about. For \`suggestNewPage\` you must always provide a fresh summary since no line exists yet. Use the same target type id you used in proposals.

Output strictly this JSON shape, with no surrounding prose, code fences, or commentary. Each proposal uses *either* \`target\` (existing page) *or* \`suggestNewPage\` (create a new page) — never both.

{
  "proposals": [
    { "target": "wiki:custom-7ntdvj41", "content": "- Direct report", "sourceQuote": "Sarah is now reporting to me", "rationale": "added detail to existing entity" },
    { "suggestNewPage": "Books", "content": "### The Pragmatic Programmer\\n- Software craftsmanship", "sourceQuote": "Started reading The Pragmatic Programmer this week", "rationale": "no existing page hosts books" }
  ],
  "indexUpdates": [
    { "target": "wiki:custom-7ntdvj41", "summary": "Direct reports and their roles" },
    { "target": "Books", "summary": "Books I've read and their core ideas" }
  ],
  "logEntry": "## [2026-05-07] ingest | daily/2026-05-07: added Sarah's role; created Books page"
}

Note: for \`suggestNewPage\` proposals, the indexUpdates entry uses the proposed page name (the same string you put in \`suggestNewPage\`) as the target — the apply layer rewrites it to the real wiki type id after the page is created.

If proposals is empty, indexUpdates should also be empty. logEntry should still be a single line summarizing the ingest pass (e.g. "## [2026-05-07] ingest | daily/2026-05-07: nothing notable").`

/** Compose the full system prompt. The user-editable conventions
 * page (Karpathy's CLAUDE.md pattern) is prepended so it shadows
 * any stylistic defaults — the user always has the last word on
 * how their wiki should grow. The static rules follow because they
 * encode wire-format invariants the model must not ignore even if
 * the user wrote something contradictory in conventions. */
function composeSystemPrompt(conventions: string): string {
  const trimmed = conventions.trim()
  if (!trimmed) return SYSTEM_PROMPT_STATIC
  return `User-defined wiki conventions (read carefully — these reflect how the user wants their wiki to grow):\n\n${trimmed}\n\n---\n\n${SYSTEM_PROMPT_STATIC}`
}

/** Build the user-facing prompt body: today's date, the wiki context
 * (each page as a `[type — title — shape]` block with body), and the
 * new note text. The wiki block carries both "what targets exist"
 * and "what's already in each" — see readWikiContext for the format. */
function buildPrompt(args: {
  date: string
  noteLabel: string
  noteMarkdown: string
  wikiSnapshot: string
  indexSnapshot: string
}): string {
  const wiki = args.wikiSnapshot.trim().length
    ? args.wikiSnapshot
    : '(no wiki pages yet — propose targets only if a clearly-named one is needed)'
  // The INDEX block carries the existing one-line summary per page.
  // Showing it explicitly lets the LLM decide whether a page's
  // summary needs updating — Phase 1-B's signal that index has
  // become a first-class part of the prompt. Skip the block when
  // it's empty (no pages summarized yet) rather than emitting an
  // empty header that distracts from the WIKI section.
  const sections: string[] = [`DATE: ${args.date}`, '']
  if (args.indexSnapshot.trim().length) {
    sections.push('INDEX (current — one summary line per wiki page):')
    sections.push(args.indexSnapshot)
    sections.push('')
  }
  sections.push('WIKI:')
  sections.push(wiki)
  sections.push('')
  sections.push(`NEW NOTE (${args.noteLabel}):`)
  sections.push(args.noteMarkdown)
  return sections.join('\n')
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
    if (!md || md.replace(/[​\s]/g, '') === '') return ''
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

/** Pull a stable JSON object out of the assistant's response. The
 * system prompt asks for raw JSON, but Haiku occasionally wraps it
 * in a code fence or adds a sentence; we strip those defensively. */
function extractJson(raw: string): unknown {
  const trimmed = raw.trim()
  // Fast path — model followed instructions.
  try {
    return JSON.parse(trimmed)
  } catch {
    /* fall through */
  }
  // Strip ``` ... ``` fence if present.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fence) {
    try {
      return JSON.parse(fence[1])
    } catch {
      /* fall through */
    }
  }
  // Last resort: substring from first { to last }.
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1))
    } catch {
      /* nothing more to try */
    }
  }
  return null
}

interface ParsedIngest {
  proposals: IngestProposal[]
  indexUpdates: IndexUpdate[]
  logEntry: string | null
}

/** Validate the parsed JSON against the contract. Drops anything
 * that doesn't match — better to silently skip a malformed proposal
 * than to apply garbage to the wiki later. */
function validateParsed(value: unknown): ParsedIngest {
  if (!value || typeof value !== 'object') {
    return { proposals: [], indexUpdates: [], logEntry: null }
  }
  const obj = value as Record<string, unknown>
  const rawProposals = Array.isArray(obj.proposals) ? obj.proposals : []
  const proposals: IngestProposal[] = []
  for (const p of rawProposals) {
    if (!p || typeof p !== 'object') continue
    const rec = p as Record<string, unknown>
    const target = typeof rec.target === 'string' && rec.target.trim()
      ? rec.target.trim()
      : null
    const suggestNewPage =
      typeof rec.suggestNewPage === 'string' && rec.suggestNewPage.trim()
        ? rec.suggestNewPage.trim()
        : null
    const content = typeof rec.content === 'string' ? rec.content : null
    if (!content) continue
    // Routing must specify exactly one of target / suggestNewPage.
    // If both are present we keep target (less destructive — uses an
    // existing page rather than spawning a new one). If neither, the
    // proposal has nowhere to land and we drop it.
    if (!target && !suggestNewPage) continue
    const rationale =
      typeof rec.rationale === 'string' ? rec.rationale : undefined
    const sourceQuote =
      typeof rec.sourceQuote === 'string' && rec.sourceQuote.trim()
        ? rec.sourceQuote.trim()
        : undefined
    proposals.push({
      ...(target ? { target } : { suggestNewPage: suggestNewPage! }),
      content,
      rationale,
      sourceQuote,
    })
  }
  // System-owned pages must never appear in indexUpdates — they are
  // the index/log/conventions themselves, never targets the LLM is
  // allowed to summarize. Defensive filter even though the catalog
  // snapshot already excludes them, so a hallucinated id can't sneak
  // a stray summary line into the index.
  const SYSTEM_TARGETS = new Set(['system:index', 'system:log', 'system:conventions'])
  const rawIndex = Array.isArray(obj.indexUpdates) ? obj.indexUpdates : []
  const indexUpdates: IndexUpdate[] = []
  for (const u of rawIndex) {
    if (!u || typeof u !== 'object') continue
    const rec = u as Record<string, unknown>
    const target =
      typeof rec.target === 'string' && rec.target.trim()
        ? rec.target.trim()
        : null
    const summary =
      typeof rec.summary === 'string' && rec.summary.trim()
        ? rec.summary.trim()
        : null
    if (!target || !summary) continue
    if (SYSTEM_TARGETS.has(target)) continue
    indexUpdates.push({ target, summary })
  }
  const logEntry =
    typeof obj.logEntry === 'string' && obj.logEntry.trim()
      ? obj.logEntry.trim()
      : null
  return { proposals, indexUpdates, logEntry }
}

/** Wait for one chat run to complete on the chat sidecar, returning
 * the accumulated assistant text. Listens to the standard claude:*
 * event channels filtered by runId; cleans up listeners on settle. */
function awaitChatRun(runId: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
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
    const settleOk = (text: string) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(text)
    }
    const settleErr = (err: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    Promise.all([
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
        // Stream-event path — accumulate text deltas as they arrive.
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
        // Final assistant message — fallback path. The SDK emits both,
        // but if for some reason stream events were missed, this
        // recovers the full content from the consolidated message.
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
          settleOk(assistantText)
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

  const noteMarkdown = await readDocMarkdown(noteSlug)
  if (!noteMarkdown) {
    return {
      proposals: [],
      indexUpdates: [],
      logEntry: null,
      raw: '',
      malformed: false,
    }
  }
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
    wikiSnapshot,
    indexSnapshot,
  })

  const runId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()
  const finished = awaitChatRun(runId)
  await invoke('claude_chat_start', {
    args: {
      runId,
      model: INGEST_MODEL,
      systemPrompt: composeSystemPrompt(conventions),
      prompt,
      relayTools: [],
      effort: 'low',
      sessionId,
    },
  })
  const raw = await finished
  console.log('[ingest:producer] LLM responded', { rawLength: raw.length })
  const parsedJson = extractJson(raw)
  if (!parsedJson) {
    console.warn('[ingest:producer] could not extract JSON from response')
    return { proposals: [], indexUpdates: [], logEntry: null, raw, malformed: true }
  }
  const { proposals, indexUpdates, logEntry } = validateParsed(parsedJson)
  console.log('[ingest:producer] validated', {
    proposals: proposals.length,
    indexUpdates: indexUpdates.length,
    logEntry: !!logEntry,
    targets: proposals.map((p) => p.target ?? `new:${p.suggestNewPage}`),
  })
  return { proposals, indexUpdates, logEntry, raw, malformed: false }
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
