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
import { readWikiContext } from '@/state/wikiService'

const PROOF_BASE_URL = 'http://localhost:4000'
const INGEST_MODEL = 'claude-haiku-4-5-20251001'

/** A single proposed wiki edit. v1 = append-only (the LLM may not
 * modify or delete existing lines). The renderer uses `target` to
 * route the append to the right wiki:* doc and `content` as the raw
 * markdown to add. Format of `content` is whatever the LLM emits —
 * usually a single bullet line or short paragraph. */
export interface IngestProposal {
  /** wiki:* type id (e.g. 'wiki:entity', 'wiki:custom-7nt...'). */
  target: string
  /** Markdown to append to the target page's body. */
  content: string
  /** Short reason the LLM gave for proposing this. Optional. */
  rationale?: string
  /** For entity-shaped pages: the existing H3 heading (without the
   * leading `### `) under which this content should be appended.
   * Omitted when the proposal introduces a new H3 itself, or when the
   * target page isn't entity-shaped. The apply layer (Step 4) uses
   * this to slot bullets into the right entity section instead of
   * always appending at the end. */
  anchorH3?: string
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

const SYSTEM_PROMPT = `You maintain a personal wiki on the user's behalf. The user just wrote a note. Your job: identify any information in the note that should be reflected in the wiki, and propose append-only edits to the relevant wiki pages.

Hard rules:
- APPEND ONLY. Never propose modifying or deleting existing lines.
- Only propose edits when the note contains genuinely new, durable information (people, decisions, facts about the user, project state). Skip transient mood, weather, small talk.
- Each proposal targets ONE wiki page by its type id (e.g. "wiki:entity"). Use the "Available wiki pages" list below — do not invent targets.
- Be concise. Each proposal's "content" is one bullet line or short paragraph — not a wall of text.
- If nothing in the note merits a wiki update, return an empty proposals array.
- Always include a log entry summarizing what you did (or "nothing notable today" if proposals is empty).

Each wiki page header carries a shape label, e.g. "[USER PEOPLE — entity]". Match the page's existing convention so it stays scannable:
- entity: page is organized as "### Name" blocks with bullets underneath.
    * New subject  → content is the full block, e.g. "### Mike\\n- AI researcher\\n- First met 2026-05-07". Omit anchorH3.
    * Existing subject → content is bullet(s) only, e.g. "- Direct report". Set anchorH3 to that subject's exact heading text (e.g. "Sarah").
- list: page is flat bullets, no H3 sections. Content is one or more bullets ("- ..."). Never introduce "### " here.
- timeline: append-only date log. Content follows "## [YYYY-MM-DD] kind | summary" exactly.
- prose / empty: page hasn't settled into a shape yet. Pick the most natural shape for the content type (entity for people/things, list for preferences, etc.) and start it.

Output strictly this JSON shape, with no surrounding prose, code fences, or commentary:

{
  "proposals": [
    { "target": "wiki:custom-people", "content": "- Direct report", "anchorH3": "Sarah", "rationale": "added detail to existing entity" }
  ],
  "logEntry": "## [2026-05-07] ingest | daily/2026-05-07: added Sarah's role"
}

If proposals is empty, logEntry should still be a single line summarizing the ingest pass (e.g. "## [2026-05-07] ingest | daily/2026-05-07: nothing notable").`

interface AvailableTarget {
  type: string
  label: string
}

/** Build the user-facing prompt body: today's date, the available
 * wiki targets, the current wiki snapshot, and the new note text. */
function buildPrompt(args: {
  date: string
  noteLabel: string
  noteMarkdown: string
  availableTargets: AvailableTarget[]
  wikiSnapshot: string
}): string {
  const targets = args.availableTargets
    .map((t) => `- ${t.type} (${t.label})`)
    .join('\n')
  const snapshot = args.wikiSnapshot.trim().length
    ? args.wikiSnapshot
    : '(wiki is empty)'
  return [
    `DATE: ${args.date}`,
    '',
    'AVAILABLE WIKI PAGES:',
    targets,
    '',
    'CURRENT WIKI SNAPSHOT:',
    snapshot,
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
    const target = typeof rec.target === 'string' ? rec.target : null
    const content = typeof rec.content === 'string' ? rec.content : null
    if (!target || !content) continue
    const rationale =
      typeof rec.rationale === 'string' ? rec.rationale : undefined
    const anchorH3 =
      typeof rec.anchorH3 === 'string' && rec.anchorH3.trim()
        ? rec.anchorH3.trim()
        : undefined
    proposals.push({ target, content, rationale, anchorH3 })
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

/** List every wiki:* doc currently in the catalog so the prompt
 * knows which targets are valid. The label is the user-visible name
 * the LLM should refer to (so it picks the right one out of a list
 * of opaque custom-<id> types). */
function listAvailableTargets(): AvailableTarget[] {
  return useDocsStore
    .getState()
    .knownDocs.filter((d) => d.type.startsWith('wiki:') && !d.archivedAt)
    .map((d) => ({
      type: d.type,
      label: d.title?.trim() || d.type.replace(/^wiki:/, ''),
    }))
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
  const availableTargets = listAvailableTargets()
  const noteLabel =
    known.type === 'daily' && known.date
      ? `daily/${known.date}`
      : known.title?.trim() || noteSlug

  const prompt = buildPrompt({
    date: todayLocalDate(),
    noteLabel,
    noteMarkdown,
    availableTargets,
    wikiSnapshot,
  })

  const runId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()
  const finished = awaitChatRun(runId)
  await invoke('claude_chat_start', {
    args: {
      runId,
      model: INGEST_MODEL,
      systemPrompt: SYSTEM_PROMPT,
      prompt,
      relayTools: [],
      effort: 'low',
      sessionId,
    },
  })
  const raw = await finished
  const parsedJson = extractJson(raw)
  if (!parsedJson) {
    return { proposals: [], logEntry: null, raw, malformed: true }
  }
  const { proposals, logEntry } = validateParsed(parsedJson)
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
