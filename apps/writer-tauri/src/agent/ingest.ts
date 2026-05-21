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
import { awaitChatRun } from '@/agent/chatRun'
import { useDocsStore, isWikiDoc } from '@/state/docsStore'
import { useEditorViewStore } from '@/state/editorViewStore'
import { useIngestStore } from '@/state/ingestStore'
import { isEffectivelyEmpty } from '@/lib/markdownText'
import { pickNewBlocks } from '@/lib/blockHash'
import { ensureConventionsWikiSlug, ensureProfileWikiSlug } from '@/state/wikiService'
import { assembleContext } from '@/agent/contextPipeline'
import type { WikiPageBody } from '@/agent/contextSelector'
import {
  selectActiveThreadsForIngest,
  type ActiveThreadSummary,
} from '@/agent/selectActiveThreadsForIngest'
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
const SYSTEM_PROMPT_STATIC = `You maintain a personal wiki on the user's behalf. The user's recent activity — a new note AND any chat threads active since the last ingest — appears below. Your job: identify facts in this activity that should be reflected in the wiki, and propose append-only edits to the relevant wiki pages.

## Inputs you receive

- INDEX block — system-built catalog of every wiki page. One line per page in the form: \`- <path> [<type-id>] — <title>: <summary> | links: <N>\`. The \`[<type-id>]\` bracket (e.g. \`[wiki:custom-7n2dvj41]\`) is the verbatim string you copy into a proposal's \`target\` field when adding to that page. Treat the INDEX itself as read-only — the host rebuilds it deterministically; do not emit updates for it.
- WIKI PAGE blocks — full bodies of pages mentioned via \`[[link]]\` in the new note. Read each body to learn what shape the page has and what kind of content belongs there. The page's body is the ground truth for its current pattern.
- TODAY'S CHAT ACTIVITY block (optional) — \`entity: fact\` bullets pre-extracted from chat threads the user had since the last ingest. Treat these as a fact source on equal footing with the new note. Bullets are already in your proposal shape; pick them up verbatim when relevant, or merge them into existing pages.

## What to propose

Only propose facts that meaningfully add to or change wiki state. Skip:
- Passing mentions ("met Sarah today") without new substance about the entity.
- Restatements of facts already present in the WIKI PAGE bodies or INDEX summaries.
- Self-reports ("today I thought about X") unless they reveal a new fact about X.
- Speculation, questions, or hypotheticals.

When in doubt, omit. A clean empty pass is better than noise.

## Routing self-facts to wiki:profile

The INDEX includes \`[wiki:profile]\` — the user's own profile page (the person described in the SELF PROFILE block above). Route facts about the USER themselves there: career or role changes, location moves, new interests they're committing to, stable beliefs about themselves. Casual self-reports stay out per the "What to propose" filter above; mentions of other people go to those people's pages, not the profile.

\`entity\` for a wiki:profile proposal is what the update is about (e.g. \`Career\`, \`Move to Seoul\`, \`Reading goals\`). The host appends it as \`### {entity}\` like any other page.

## Invariants (do not violate)

- APPEND ONLY. Never propose modifying or deleting existing lines.
- \`target\` is the verbatim \`[<type-id>]\` from the INDEX line — never invent ids.
- Each proposal is atomic: ONE \`entity\` (topic name — a person, a book, a project) and a list of \`bullets\` (the facts about that entity). DO NOT emit page-level or sub-section headings inside bullets — the host assembles \`### {entity}\\n- {bullet}\` automatically. Bullets are plain text only: no leading \`-\`, no nested headings, no \`##\` or \`###\`.
- Always include a \`sourceQuote\`: the exact sentence (or short clause) the proposal was derived from. For note-derived facts, echo from the note verbatim. For chat-derived facts, use the bullet text from the chat block (optionally prefix with the thread title in parentheses).
- The wiki is FLAT — every entity is its own page at the same level. Do not create category pages. Each fact about a person belongs on a page named after that person, not on a shared "People" page. Same for books, projects, concepts.

## Cross-linking

When a bullet mentions another wiki page that already exists in the INDEX, wrap that page's title with double-brackets so it renders as a clickable link. Use the title exactly as it appears in the INDEX line. Skip the link when:
- The page being mentioned is the same one you're writing to (no self-links — don't link \`entity\` from inside its own bullets either).
- No existing page matches the mention (don't invent links).

Example: if "Alex" appears as the title of \`[wiki:custom-9k4...]\` in the INDEX, a bullet should read \`Working with [[Alex]] on the project\`, not \`Working with Alex on the project\`. This applies to both \`target\`-bound and \`suggestNewPage\` proposals.

## Output

When done, call the \`submit_ingest_result\` tool **exactly once** with the structured result. Do not emit JSON in your text response — the tool is the only channel that lands in the wiki. Each proposal uses *either* \`target\` (existing page) *or* \`suggestNewPage\` (create a new page), never both. Example arguments:

{
  "proposals": [
    { "target": "wiki:custom-7ntdvj41", "entity": "Sarah", "bullets": ["Now reports directly to me"], "sourceQuote": "Sarah is now reporting to me", "rationale": "added detail to existing entity" },
    { "target": "wiki:profile", "entity": "Career", "bullets": ["Joined Acme as Senior Engineer (Apr 2026)"], "sourceQuote": "Started at Acme today as a senior engineer.", "rationale": "user's career change — updates the profile" },
    { "suggestNewPage": "The Pragmatic Programmer", "entity": "The Pragmatic Programmer", "bullets": ["Software craftsmanship", "Started reading this week"], "sourceQuote": "Started reading The Pragmatic Programmer this week", "rationale": "new entity not in INDEX yet" }
  ],
  "logEntry": "## [2026-05-07] ingest | daily/2026-05-07: added Sarah's role; logged new role on profile; created The Pragmatic Programmer page"
}

If you found nothing worth filing, still call the tool — pass an empty array for proposals AND pass \`null\` (not a string) for logEntry. The host suppresses empty passes entirely so they don't pile up in wiki:log. A pass without a tool call is treated as malformed and discarded.

When you DO have something to file (proposals is non-empty), the logEntry must be a single line summarizing what got filed — one entry per ingest, never per-block verdicts. "added Sarah's role; created Books page" is right; enumerating "block A: kept, block B: transient, block C: filed" is wrong.`

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
  indexSnapshot: string
  hotPages: WikiPageBody[]
  conventions: string
  chatActivity: ActiveThreadSummary[]
  selfProfile: string
}): string[] {
  const trimmedConventions = args.conventions.trim()
  const rules = trimmedConventions
    ? `User-defined wiki conventions (read carefully — these reflect how the user wants their wiki to grow):\n\n${trimmedConventions}\n\n---\n\n${SYSTEM_PROMPT_STATIC}`
    : SYSTEM_PROMPT_STATIC

  const blocks: string[] = [rules]

  // Self profile — what the system already knows about the user.
  // Lands BEFORE the wiki index so the model reads "who this person
  // is" before scanning candidate pages; routing decisions (e.g. is
  // this fact about THEM or someone else?) become accurate.
  // When the page is empty the block is omitted — same shape as the
  // chat path so the model never sees a "(empty profile)" header.
  if (args.selfProfile.trim().length) {
    blocks.push(
      `--- SELF PROFILE (the user, auto-updated) ---\n${args.selfProfile}`,
    )
  }

  if (args.indexSnapshot.trim().length) {
    blocks.push(
      `--- INDEX (current — one summary line per wiki page) ---\n${args.indexSnapshot}`,
    )
  } else {
    blocks.push(
      '--- INDEX ---\n(no wiki pages yet — propose targets only if a clearly-named one is needed)',
    )
  }

  // Tier 2 — bodies of pages this note's [[link]]s point at. Pinned
  // per-block so the cache key matches when the same daily is
  // ingested repeatedly with the same wikilinks.
  for (const page of args.hotPages) {
    blocks.push(`--- WIKI PAGE: ${page.title} ---\n${page.body}`)
  }

  // Chat activity since last ingest pass. Each thread arrives
  // pre-shaped as `- entity: fact` bullets (compactChatThread), so
  // the model can treat them as fact sources the same way it does
  // the daily body — no second transformation pass. Block goes
  // last so prefix cache (rules → index → hot pages) stays warm
  // when only chat changes between runs.
  if (args.chatActivity.length > 0) {
    const chatBody = args.chatActivity
      .map((t) => `[Thread: "${t.threadTitle}"]\n${t.summary}`)
      .join('\n\n')
    blocks.push(`--- TODAY'S CHAT ACTIVITY ---\n${chatBody}`)
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

// awaitChatRun lives in @/agent/chatRun — generic over the structured-
// output event name so the Profile bootstrap can reuse the same
// listener choreography (its event is `profile:result`).

/** Source-agnostic ingest core. Takes pre-filtered markdown plus a
 * display label and runs the wiki-context-aware LLM pass. No store
 * reads, no slug lookups, no block-hash dedup — the caller (daily
 * `runIngest` or bootstrap `bootstrapIngest`) handles whatever
 * source-specific filtering / persistence it needs.
 *
 * Returned shape mirrors `IngestResult` minus `ingestedHashes`,
 * which is daily-only state (bootstrap doesn't dedup by hash). */
export interface IngestCoreArgs {
  /** Already-filtered text to feed the model. For daily this is the
   * concatenated body of new blocks; for bootstrap it's a raw chunk
   * straight from the source file / URL. */
  text: string
  /** Free-form label used in the user prompt (`daily/YYYY-MM-DD`
   * for daily, `imported/<file>` for bootstrap). Surfaces as the
   * provenance string the LLM cites in its proposals. */
  sourceLabel: string
  /** Chat-thread watermark for `selectActiveThreadsForIngest`.
   * Daily passes `lastIngestedAt[slug]`; bootstrap passes 0 so the
   * first run sees every thread. */
  sinceTs: number
  /** Doc slug whose threads should contribute to the chat-activity
   * block. Each thread's `parentSlug` is matched against this. Pass
   * null to omit chat activity (bootstrap before any doc opens). */
  threadSlug: string | null
}

export interface IngestCoreResult {
  proposals: IngestProposal[]
  logEntry: string | null
  raw: string
  malformed: boolean
}

export async function runIngestCore(args: IngestCoreArgs): Promise<IngestCoreResult> {
  const { text, sourceLabel, sinceTs, threadSlug } = args

  // Seed the conventions page on first need so the user has
  // something to edit; assembleContext reads the result a moment
  // later. Failures degrade gracefully — empty conventions means
  // the static rules take over alone.
  await ensureConventionsWikiSlug()
  // Same lazy-seed for the self-profile page. Guarantees `wiki:profile`
  // shows up in the INDEX so the model can route self-facts there
  // even for users who skipped the URL bootstrap — the page just
  // starts empty and fills from daily activity instead.
  await ensureProfileWikiSlug()
  // Run wiki context assembly and chat compaction in parallel —
  // they read independent state and the chat side may include
  // several LLM calls for stale threads, so paying once is much
  // cheaper than serializing.
  const [ctx, chatActivity] = await Promise.all([
    // One facade call replaces the prior three (wiki dump + index +
    // conventions). Tier 2 hot pages come from [[link]]s in the
    // source text — same daily / import can mention multiple
    // existing wiki pages, and now their bodies ride along
    // automatically. We skip the Tier 3 tool list (enableTools:
    // false) because ingest is single-shot — the LLM emits one
    // submit_ingest_result call and has no room to drive
    // read_page/search_wiki.
    assembleContext({ docBody: text, enableTools: false }),
    // Chat activity since the previous successful ingest. Empty
    // array when no slug is available (bootstrap before any doc
    // opens) or on quiet days where no thread had a new turn since
    // sinceTs.
    threadSlug
      ? selectActiveThreadsForIngest({ slug: threadSlug, sinceTs })
      : Promise.resolve<ActiveThreadSummary[]>([]),
  ])

  const prompt = buildPrompt({
    date: todayLocalDate(),
    noteLabel: sourceLabel,
    noteMarkdown: text,
  })
  const systemPrompt = composeSystemPrompt({
    indexSnapshot: ctx.index,
    hotPages: ctx.hotPages,
    conventions: ctx.conventions,
    chatActivity,
    selfProfile: ctx.selfProfile,
  })

  const runId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()
  const finished = awaitChatRun<IngestToolInput>(runId, 'ingest:result')
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
    return {
      proposals: [],
      logEntry: null,
      raw: outcome.text,
      malformed: true,
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
  }
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

  const sinceTs = useIngestStore.getState().lastIngestedAt[noteSlug] ?? 0
  const noteLabel =
    known.type === 'daily' && known.date
      ? `daily/${known.date}`
      : known.title?.trim() || noteSlug

  const core = await runIngestCore({
    text: noteMarkdown,
    sourceLabel: noteLabel,
    sinceTs,
    threadSlug: noteSlug,
  })

  return {
    ...core,
    // Malformed pass: don't persist the hash snapshot — the LLM
    // never "consumed" these blocks, so leave the store as-is so
    // the next pass retries with the same content.
    ingestedHashes: core.malformed ? [] : allHashes,
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
