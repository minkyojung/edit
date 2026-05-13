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
import { useDocsStore } from '@/state/docsStore'
import {
  readWikiContext,
  readConventions,
  ensureConventionsWikiSlug,
  ensureIndexWikiSlug,
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
- Be concise. Each proposal's "content" is one bullet line or short block — not a wall of text.
- Always include a log entry summarizing what you did (or "nothing notable today" if proposals is empty).

Always include "sourceQuote": the exact sentence (or short clause) from the new note that this proposal was derived from. Echo it verbatim — it's the user's audit trail for verifying the proposal landed in the right page. If the proposal aggregates several lines, quote the most representative one.

Output strictly this JSON shape, with no surrounding prose, code fences, or commentary. Each proposal uses *either* \`target\` (existing page) *or* \`suggestNewPage\` (create a new page) — never both.

{
  "proposals": [
    { "target": "wiki:custom-7ntdvj41", "content": "- Direct report", "sourceQuote": "Sarah is now reporting to me", "rationale": "added detail to existing entity" },
    { "suggestNewPage": "Books", "content": "### The Pragmatic Programmer\\n- Software craftsmanship", "sourceQuote": "Started reading The Pragmatic Programmer this week", "rationale": "no existing page hosts books" }
  ],
  "logEntry": "## [2026-05-07] ingest | daily/2026-05-07: added Sarah's role; created Books page"
}

If proposals is empty, logEntry should still be a single line summarizing the ingest pass (e.g. "## [2026-05-07] ingest | daily/2026-05-07: nothing notable").`

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
}): string {
  const wiki = args.wikiSnapshot.trim().length
    ? args.wikiSnapshot
    : '(no wiki pages yet — propose targets only if a clearly-named one is needed)'
  return [
    `DATE: ${args.date}`,
    '',
    'WIKI:',
    wiki,
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
  logEntry: string | null
}

/** Validate the parsed JSON against the contract. Drops anything
 * that doesn't match — better to silently skip a malformed proposal
 * than to apply garbage to the wiki later. */
function validateParsed(value: unknown): ParsedIngest {
  if (!value || typeof value !== 'object') {
    return { proposals: [], logEntry: null }
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
  const logEntry =
    typeof obj.logEntry === 'string' && obj.logEntry.trim()
      ? obj.logEntry.trim()
      : null
  return { proposals, logEntry }
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
  if (known.type.startsWith('wiki:')) {
    // Wiki pages are the LLM's output, not its input — ingesting one
    // would mean asking the model to summarize itself. The trigger
    // layer (PR 3-2) enforces this too, but guard here so console
    // testing can't accidentally poison the wiki with self-echo.
    throw new Error(`refusing to ingest a wiki page: ${noteSlug}`)
  }

  const noteMarkdown = await readDocMarkdown(noteSlug)
  if (!noteMarkdown) {
    return {
      proposals: [],
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
  // Seed the index page on first need. Phase 1-A: the page exists
  // in the catalog but stays empty; later phases populate it from
  // ingest output and (Phase 2) feed it back as the prompt context.
  // Fire-and-forget — a failed create just means the page lazily
  // appears on the next pass.
  void ensureIndexWikiSlug()
  const noteLabel =
    known.type === 'daily' && known.date
      ? `daily/${known.date}`
      : known.title?.trim() || noteSlug

  const prompt = buildPrompt({
    date: todayLocalDate(),
    noteLabel,
    noteMarkdown,
    wikiSnapshot,
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
    return { proposals: [], logEntry: null, raw, malformed: true }
  }
  const { proposals, logEntry } = validateParsed(parsedJson)
  console.log('[ingest:producer] validated', {
    proposals: proposals.length,
    logEntry: !!logEntry,
    targets: proposals.map((p) => p.target ?? `new:${p.suggestNewPage}`),
  })
  return { proposals, logEntry, raw, malformed: false }
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
