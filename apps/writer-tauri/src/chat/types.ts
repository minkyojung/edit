// Shared types for the chat surface (threads + turns).
//
// Persisted as a pair of vault files per thread:
//   threads/<id>.json         — ThreadMeta (this file's shape).
//   threads/<id>.turns.jsonl  — one ChatTurn per line, append-only.
//
// The meta JSON is rewritten atomically (vault.ts's tmp+rename) on
// any metadata change (rename, archive, model switch). Turns are
// appended one line at a time as the SDK finishes each turn —
// append is atomic on POSIX for writes under PIPE_BUF (~4 KB);
// larger turns rely on the kernel's serialised write to the same fd
// from a single process. Because we only ever append (no rewrite),
// a mid-write crash truncates at most one trailing turn rather
// than corrupting the file.

// Fetched-catalog facts, consulted by the lookups below. modelFacts imports
// nothing, so this direction can't cycle.
import { modelFactsFor } from '@/chat/modelFacts'

/** Models the user can pick from in the PromptInput model selector.
 * Kept narrow + explicit so the UI can display friendly labels without
 * round-tripping through agent ids. The sidecar accepts the raw id. */
export type ChatModel =
  | 'claude-haiku-4-5'
  | 'claude-sonnet-5'
  | 'claude-opus-5'
  | 'claude-opus-4-8'
  | 'claude-fable-5'
  // Legacy — kept selectable for threads created before Sonnet 5, but listed
  // last and not the default.
  | 'claude-sonnet-4-6'

export const CHAT_MODELS: readonly ChatModel[] = [
  'claude-haiku-4-5',
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-fable-5',
  'claude-sonnet-4-6',
] as const

export const CHAT_MODEL_LABELS: Record<ChatModel, string> = {
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-opus-5': 'Opus 5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-fable-5': 'Fable 5',
  'claude-sonnet-4-6': 'Sonnet 4.6',
}

export const DEFAULT_CHAT_MODEL: ChatModel = 'claude-sonnet-5'

/** Display name for a model id, in order of freshness: the fetched catalog, the
 * built-in table, then the bare id minus its `claude-` prefix — never an empty
 * string. Indexing CHAT_MODEL_LABELS directly is what made an unrecognized id
 * (a thread saved before a model was added, a persisted setting, a slash command
 * naming a model we don't list) render as a blank button.
 *
 * The built-in table is kept ahead of the raw id but BEHIND the catalog: our
 * labels are terser than the API's ("Opus 4.8" vs "Claude Opus 4.8") for models
 * we know, while the catalog is the only source for one we don't. */
export function labelForModel(model: string): string {
  const known = CHAT_MODEL_LABELS[model as ChatModel]
  if (known) return known
  const fromCatalog = modelFactsFor(model)?.displayName
  if (fromCatalog) {
    // The API spells them "Claude Opus 4.7" where our table says "Opus 4.7".
    // Without this the picker mixes both conventions in one list — the models
    // we ship with read one way and the ones the catalog supplied read another,
    // which looks like two different lists rather than one.
    const stripped = fromCatalog.replace(/^claude\s+/i, '').trim()
    return stripped || fromCatalog
  }
  return model.replace(/^claude-/, '')
}

/** One model the account can actually use, as reported by the Claude Agent
 * SDK's session-init handshake (query.supportedModels()). Only `value` is
 * consumed today — the picker intersects CHAT_MODELS against these so models
 * the account lacks access to (e.g. region-gated) stay hidden. The capability
 * fields mirror the SDK shape and are kept for future use. */
export interface ModelInfo {
  value: string
  displayName?: string
  description?: string
  supportsFastMode?: boolean
  supportedEffortLevels?: string[]
}

/** Coerce a persisted model id to a currently-offered one. Threads created
 * before a model was retired carry an id no longer in CHAT_MODELS (e.g.
 * `claude-opus-4-7`); map the known predecessor to its successor and fall
 * back to the default for anything else, so the selector and the per-model
 * effort list never read an unknown key. */
export function normalizeModel(model: string | undefined): ChatModel {
  if (model && (CHAT_MODELS as readonly string[]).includes(model)) return model as ChatModel
  if (model === 'claude-opus-4-7') return 'claude-opus-4-8'
  return DEFAULT_CHAT_MODEL
}

/** Fast mode = faster output without downgrading the model. The SDK marks
 * which models support it (`supportsFastMode`); in our lineup only Opus does.
 * Mirrors effortsForModel's client-side capability gating, so the toggle only
 * shows where it's real.
 *
 * Opus 5 is deliberately NOT listed yet: supportedModels() doesn't report it at
 * all (it still describes Opus as 4.8), so there's no `supportsFastMode` flag to
 * read, and a probe couldn't settle it either — a fastMode turn came back
 * `fast_mode_state: 'off'` on Opus 4.8 too, which this account is flagged for.
 * Offering a toggle that silently does nothing is worse than omitting it; flip
 * this the moment the SDK handshake lists Opus 5 with the flag. */
export function modelSupportsFastMode(model: ChatModel): boolean {
  return model === 'claude-opus-4-8'
}

/** Actual fast-mode state the SDK reports on the turn result (`fast_mode_state`)
 * — the truth, not just what we requested: `on` active, `cooldown` temporarily
 * forced off after a rate limit, `off` not enabled. */
export type FastModeState = 'off' | 'cooldown' | 'on'

/** Reasoning effort the model puts into a turn. Mirrors the Claude Agent
 * SDK's first-class `effort` option. `xhigh` is only on the higher tiers
 * (Sonnet 5, Opus 4.8, Fable 5) — the SDK falls back to `high` on models
 * without it, so we only offer it where it's real (see EFFORTS_BY_MODEL).
 * `max` is intentionally not exposed: its token/time cost
 * is disproportionate for a writing tool. */
export type ChatEffort = 'low' | 'medium' | 'high' | 'xhigh'

/** Every valid effort value — the enum used to validate slash-command
 * frontmatter. The per-model subset a user can actually pick lives in
 * EFFORTS_BY_MODEL. */
export const CHAT_EFFORTS: readonly ChatEffort[] = ['low', 'medium', 'high', 'xhigh'] as const

/** Effort levels offered per model, in ascending order. Opus exposes the
 * extra `xhigh` gear; the others top out at `high`. The EffortButton draws
 * one ring per entry, so this also drives how many circles the icon shows. */
export const EFFORTS_BY_MODEL: Record<ChatModel, readonly ChatEffort[]> = {
  'claude-haiku-4-5': ['low', 'medium', 'high'],
  // Sonnet 5 is the first Sonnet-tier model to expose the extra `xhigh` gear;
  // Sonnet 4.6 tops out at `high`.
  'claude-sonnet-5': ['low', 'medium', 'high', 'xhigh'],
  'claude-opus-5': ['low', 'medium', 'high', 'xhigh'],
  'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh'],
  'claude-fable-5': ['low', 'medium', 'high', 'xhigh'],
  'claude-sonnet-4-6': ['low', 'medium', 'high'],
}

/** Efforts offered for a model we have no entry for. Every Claude model exposes
 * at least low/medium/high, so this is the safe floor: an unknown id renders a
 * working picker instead of crashing. `xhigh` is deliberately omitted — offering
 * a gear the model may not have is worse than under-offering one it does (the
 * catalog fills the real list in once it lands). */
const FALLBACK_EFFORTS: readonly ChatEffort[] = ['low', 'medium', 'high']

/** Takes a plain string, not ChatModel: a persisted thread, a slash-command
 * frontmatter field, or the runtime-fetched catalog can all carry an id that
 * isn't in our built-in union. Falling back keeps those paths alive.
 *
 * The built-in table wins over the catalog for models we ship with, because it
 * encodes a product decision the API can't: `max` is a real tier the catalog
 * reports, but we don't expose it (disproportionate token/time cost for a
 * writing tool). For a model we DON'T know, the catalog's tiers are the only
 * information available and beat guessing. */
export function effortsForModel(model: string): readonly ChatEffort[] {
  const known = EFFORTS_BY_MODEL[model as ChatModel]
  if (known) return known
  const fromCatalog = modelFactsFor(model)?.efforts?.filter((e): e is ChatEffort =>
    (CHAT_EFFORTS as readonly string[]).includes(e),
  )
  return fromCatalog && fromCatalog.length > 0 ? fromCatalog : FALLBACK_EFFORTS
}

/** Snap an effort to one the model supports, falling back to its highest
 * level. Keeps a thread's stored `xhigh` from leaking into the UI / the SDK
 * call after the user switches to a model that tops out at `high`. */
export function clampEffort(effort: ChatEffort, model: string): ChatEffort {
  const allowed = effortsForModel(model)
  return allowed.includes(effort) ? effort : allowed[allowed.length - 1]
}

export const CHAT_EFFORT_LABELS: Record<ChatEffort, string> = {
  low: 'Fast response',
  medium: 'Balanced',
  high: 'Deep thinking',
  xhigh: 'Maximum thinking',
}

export const DEFAULT_CHAT_EFFORT: ChatEffort = 'medium'

/** Chat interaction mode — our surface of the SDK's permission modes.
 * - `edit` (default): the model proposes changes via the propose_* tools; each
 *   lands as a pending change the user reviews (Keep/Reject). SDK permissionMode
 *   'default'.
 * - `acceptEdits`: same proposal flow, but each change is auto-accepted the
 *   moment it lands — applied without a manual Keep (the diff still renders, now
 *   already-applied). Mirrors the SDK's 'acceptEdits' mode: edits apply
 *   automatically. For fast, trusted runs.
 * - `plan`: read-only — the model explores and writes a plan but cannot propose
 *   or apply edits (permissionMode 'plan' + propose_* relays and Bash dropped). */
export type ChatMode = 'edit' | 'acceptEdits' | 'plan'
// Default is `acceptEdits` (Apply): the product surfaces only Apply + Plan, so
// new threads auto-apply edits. `edit` (review-each) stays a valid value for
// any thread already persisted with it, just not offered in the picker.
export const DEFAULT_CHAT_MODE: ChatMode = 'acceptEdits'

// ── Context usage (gauge) ───────────────────────────────────────
//
// Snapshot of how full the model's context window is after a turn.
// STEP 2 fills only the totals (derived from the SDK `usage` already
// emitted on chat/done). `categories` + `autoCompactThreshold` arrive
// in STEP 3, once the sidecar switches to streaming-input mode and can
// call query.getContextUsage(). The gauge/popover render `categories`
// when present and fall back to a Used/Free split otherwise.

/** One row of the context breakdown (system prompt, messages, tools, …).
 * Mirrors `getContextUsage().categories[]`. `color` is the SDK-provided
 * swatch; absent in the STEP-2 fallback. */
export interface ContextCategory {
  name: string
  tokens: number
  color?: string
  isDeferred?: boolean
}

export interface ContextSnapshot {
  /** Tokens currently occupying the context window. */
  totalTokens: number
  /** Context window size. STEP-2 estimate (contextLimitForModel);
   * replaced by the real getContextUsage().maxTokens in STEP 3. */
  maxTokens: number
  /** Model the snapshot was measured against — kept so the gauge stays
   * in sync when the user switches models. */
  model: string
  /** Per-category breakdown. Absent until STEP 3. */
  categories?: ContextCategory[]
  /** Fraction (0..1) of the window at which auto-compaction triggers.
   * Absent until STEP 3; the gauge uses a fixed 0.8 warning line until
   * the real value is available. */
  autoCompactThreshold?: number
  updatedAt: number
}

export interface ThreadMeta {
  id: string
  title: string                    // empty until Haiku titler fills it in
  createdAt: number
  updatedAt: number
  archived: boolean
  archivedAt?: number              // for archive popover sort (newest first)
  /** Per-thread model override. Older threads created before this field
   * existed are missing it; treat absence as DEFAULT_CHAT_MODEL. */
  model?: ChatModel
  /** Per-thread reasoning effort. Older threads default to
   * DEFAULT_CHAT_EFFORT when this field is absent. */
  effort?: ChatEffort
  /** Per-thread interaction mode (edit vs plan). Absent on older threads;
   * treat absence as DEFAULT_CHAT_MODE. */
  mode?: ChatMode
  /** Per-thread fast-mode preference (faster Opus output). Absent/false = off.
   * Only meaningful where modelSupportsFastMode(model) is true. */
  fastMode?: boolean
  /** Last context-window snapshot for this thread, persisted so the gauge
   * survives an app restart. A resumed session keeps its prior history, so
   * the stored fill is still representative until the next turn refreshes it.
   * Absent until the first turn completes (and on pre-existing threads). */
  contextUsage?: ContextSnapshot
  /** True once the SDK has confirmed a session for this thread (set on the
   * first stream event of the first run). Subsequent runs must use `resume`
   * regardless of history shape — including Regenerate, which deletes the
   * prior assistant turn and would otherwise look like a brand-new send to
   * the history-shape heuristic. Absent on threads created before this
   * field existed; callers fall back to the legacy heuristic in that case. */
  sessionStarted?: boolean
  /** Which agent (role) drives this thread — its persona prompt + memory
   * namespace. Absent on older threads; resolveAgent() treats absence as
   * the built-in 'default'. Currently always 'default' (no role-creation
   * UX yet); the field exists so roles can be assigned without backfilling. */
  agentId?: string
}

export interface ChatTurn {
  id: string
  role: 'user' | 'assistant'
  /** Accumulated text — kept for prompt history (buildPrompt) and as a
   * fallback for legacy turns that pre-date the parts-based render. New
   * assistant turns also populate `parts`; the renderer prefers parts when
   * present. */
  content: string
  ts: number
  attachments?: Attachment[]
  /** Vault-relative paths the user @-mentioned for this turn. Display-only:
   * rendered as chips in the user bubble. The agent receives the files via
   * the system prompt's REFERENCED FILES block, not this field. */
  mentions?: { path: string }[]
  toolCalls?: ToolCall[]
  status?: 'streaming' | 'done' | 'error' | 'stopped'
  /** Accumulated reasoning text — kept for compat. New code reads it from
   * the matching `reasoning` parts. */
  thinking?: string
  /** Time-ordered timeline of an assistant turn: text, reasoning, tool
   * invocations, etc. Mirrors the Vercel AI SDK / AI Elements `parts` model.
   * Optional so old turns (which only carry `content`) still render. */
  parts?: MessagePart[]
  /** Wall-clock time the user waited for this assistant turn — measured from
   * submit to settle (done/stopped/error). Surfaced as a small footer under
   * the message. Only set on assistant turns. */
  durationMs?: number
  /** Anthropic stop_reason (`end_turn`, `max_tokens`, `pause_turn`, …).
   * Only abnormal values are surfaced in the UI — `end_turn` / `stop_sequence`
   * stay hidden as routine. */
  stopReason?: string | null
  /** Human-readable failure message for `status: 'error'` turns. Stored as
   * a separate field (not as a synthetic text part) so it stays out of the
   * prompt history and out of Copy output. */
  errorText?: string
  /** Coarse failure classification preserved separately from `errorText` so
   * the renderer can branch on it (e.g. show a `Reconnect` button only for
   * `AUTH`). Mirrors the `^([A-Z_]+):` codes the sidecar emits — `AUTH`,
   * `RATE_LIMIT`, `NETWORK`, `IDLE_TIMEOUT`, `SIDECAR_DIED`. */
  errorCode?: string
  /** For `errorCode === 'RATE_LIMIT'` only: ms-epoch when the user's quota
   * window resets. Captured from the SDK's `rate_limit_event`; drives the
   * countdown shown in the error card. Absent when the SDK didn't emit a
   * snapshot before the failure. */
  resetsAt?: number
  /** For `errorCode === 'RATE_LIMIT'` only: which window was hit
   * (e.g. 'five_hour', 'seven_day_opus'); the card turns it into a label. */
  rateLimitType?: string
  /** For `errorCode === 'RATE_LIMIT'` only: why overage/paid usage is
   * unavailable (e.g. 'out_of_credits'); lets the card say "Out of credits". */
  overageDisabledReason?: string
  /** Whether retrying could succeed. `false` for AUTH/BILLING/INVALID/BUDGET —
   * the card hides Retry. Absent → treated as retryable. */
  retryable?: boolean
  /** Set on a user turn when the message originated as a slash command
   * (e.g. `/proofread`). Lets handleRegenerate route the rerun back through
   * executeCommand's path — same system prompt, same relayTools, same
   * summarize hook — instead of replaying the literal text as plain chat. */
  slashInvocation?: { name: string; args: string }
  /** Display-only turn injected by the UI, not produced by a model run.
   * Currently set on the user-side "answer bubble" that records what the
   * user chose for an AskUserQuestion (plan-mode clarifying question). The
   * answer already reached the model as the tool's result (canUseTool), so
   * this bubble must NOT feed back into prompt building — buildUserPrompt and
   * the triggering-request lookup skip synthetic turns. It still renders and
   * persists like any other turn. */
  synthetic?: boolean
  /** Mark ids that propose_change produced during this assistant turn.
   * handleRegenerate reads these on the turn it's about to discard so it
   * can clear the matching marks from the editor before the rerun stamps
   * fresh ones — pressing Regenerate means "throw out the prior output",
   * and unowned marks accumulating across reruns would violate that. */
  appliedMarkIds?: string[]
}

/**
 * One unit in an assistant turn's timeline. Mirrors the part shape the
 * Vercel AI SDK exposes on UIMessage.parts so we can adopt their UI
 * primitives (Tool, ToolHeader, etc.) without translating.
 *
 * - `text` / `reasoning` accumulate streamed string content.
 * - `tool` represents one tool invocation; its `state` evolves from
 *   input-streaming → input-available → output-available (or output-error)
 *   as the SDK reports progress.
 * - `step-start` marks a boundary between internal model steps within a
 *   single user-visible turn (Vercel emits this between tool-call rounds).
 */
export type MessagePart =
  | TextPart
  | ReasoningPart
  | ToolPart
  | StepStartPart
  | CompactPart
  | RetryPart
  | StatusPart
  | NoticePart

export interface TextPart {
  id: string
  ts: number
  type: 'text'
  text: string
  /** Set when this part came from a subagent (SDK `parent_tool_use_id`) — the
   * tool_use id of the Task that spawned it. The renderer nests parts carrying
   * this under their parent Task lane instead of the main timeline. Undefined
   * for main-thread parts. */
  parentToolUseId?: string
}

export interface ReasoningPart {
  id: string
  ts: number
  type: 'reasoning'
  text: string
  /** See {@link TextPart.parentToolUseId}. */
  parentToolUseId?: string
}

export type ToolPartState =
  | 'input-streaming'   // input JSON is still being delivered
  | 'input-available'   // input fully decoded, awaiting result
  | 'output-available'  // result returned successfully
  | 'output-error'      // result returned with an error
  | 'approval-requested' // host needs to approve before execution

export interface ToolPart {
  id: string
  ts: number
  type: 'tool'
  toolName: string
  toolCallId: string
  /** Decoded input. While `state === 'input-streaming'`, this may be the
   * raw partial JSON string; once parsing succeeds it becomes the object. */
  input: unknown
  state: ToolPartState
  output?: unknown
  errorText?: string
  /** For host-bridged edit tools (propose_edit / propose_write /
   * propose_multi_edit): the sidecar-minted pendingId of the
   * PendingChange this call queued, parsed from the tool_result text.
   * Links this message part to its `pendingChangesStore` entry so the
   * inline suggestion card can render the diff and drive Keep / Reject.
   * Undefined until the tool_result lands (and for non-edit tools). */
  pendingId?: string
  /** For AskUserQuestion: the user's chosen answer, stamped onto the part when
   * the turn rotates (the SDK's tool output only echoes the options, not the
   * selection). Lets the question render its Q&A inline as an activity row
   * instead of a separate synthetic user bubble. */
  answer?: string
  /** For the Task tool: live subagent progress from `task_progress` system
   * messages (the subagent runs out-of-band; this is the heartbeat). */
  task?: {
    toolUses?: number
    totalTokens?: number
    lastTool?: string
    /** AI-generated "what it's doing now" line (agentProgressSummaries), e.g.
     * "Analyzing the wiki structure". Preferred over the raw tool counter. */
    summary?: string
  }
  /** See {@link TextPart.parentToolUseId}. A tool call made BY a subagent
   * carries its parent Task's id here, so it nests in that lane. */
  parentToolUseId?: string
}

export interface StepStartPart {
  id: string
  ts: number
  type: 'step-start'
}

/** A context-compaction boundary (`compact_boundary`): the SDK summarized the
 * earlier conversation to stay under the window. Rendered as a thin transcript
 * divider so the user knows older turns were condensed. */
export interface CompactPart {
  id: string
  ts: number
  type: 'compact'
  trigger: 'manual' | 'auto'
  preTokens?: number
  postTokens?: number
}

/** An `api_retry` indicator — the SDK hit a transient API error (429 / 5xx)
 * and is retrying after a back-off, during which no other events flow. A
 * single coalescing row (constant id) so the otherwise-silent pause reads as
 * "recovering", not "hung". Naturally collapses into the process summary once
 * real events resume. */
export interface RetryPart {
  id: string
  ts: number
  type: 'retry'
  /** Which attempt is starting (1-based) and the ceiling, when reported. */
  attempt?: number
  maxRetries?: number
  /** The structured error label that triggered the retry (e.g. 'server_error'). */
  error?: string
}

/** A live transport status (`system/status`) the model is in the middle of —
 * currently only `compacting` (summarizing older turns to fit the window),
 * which otherwise reads as a dead pause. Transient and coalescing (constant id
 * per turn), like {@link RetryPart}: visible while it's happening, folded into
 * the process summary once the turn moves on. The end-of-compaction divider is
 * a separate {@link CompactPart}; this fills the silent gap *during* it. */
export interface StatusPart {
  id: string
  ts: number
  type: 'status'
  state: 'compacting'
}

/** A consequential one-line notice the SDK surfaces mid-turn that isn't chat
 * content — a tool blocked by a permission rule, an automatic model fallback
 * after a refusal, or an SDK `informational` message. Persistent in the
 * timeline (unlike the transient {@link StatusPart}) so the user can see *why*
 * the turn behaved the way it did. Raw fields only; the renderer composes the
 * (localized) label, mirroring how {@link RetryPart} is rendered. */
export interface NoticePart {
  id: string
  ts: number
  type: 'notice'
  kind: 'permission-denied' | 'model-fallback' | 'model-unavailable' | 'info'
  /** permission-denied: the blocked tool, and the human reason when the SDK
   * provided one (`decision_reason`). */
  toolName?: string
  reason?: string
  /** model-fallback / model-unavailable: the model that actually answered. */
  fallbackModel?: string
  /** model-unavailable: the model the user picked, which didn't serve. Distinct
   * from `model-fallback` (a safety refusal on an available model) — here the
   * requested model simply isn't offered through this path, and the reply came
   * from a different one WITHOUT any error. The picker would otherwise keep
   * claiming a model that never answers. */
  requestedModel?: string
  /** info: the SDK's `content`, and its render level (drives prominence — the
   * transcript-only `info` level is filtered out before a part is created). */
  text?: string
  level?: 'notice' | 'suggestion' | 'warning'
  /** info: the SDK's `prevent_continuation` — the turn stopped after this
   * message (e.g. a Stop hook denied continuation). */
  blocking?: boolean
}

/** A piece of context committed onto a user turn — snapshotted from the
 * composer at send time so the bubble can render exactly what was attached
 * (and the live composer chips are cleared). */
export type Attachment =
  // Editor selection the message was about: `label` is the composer's chip
  // label ("Note · L10–14"), `preview` the selected text (tooltip).
  | { type: 'selection'; label: string; preview: string }
  // A file the user uploaded. `path` (vault-relative, under .octave/attachments/)
  // makes the turn self-contained: regenerate re-sends it, and the attachment GC
  // can tell a live file from an orphan. `name`/`mediaType` drive the chip glyph.
  | { type: 'file'; name: string; mediaType: string; path: string }
  // The non-markdown file the chat was viewing (vault-relative path).
  | { type: 'viewing-file'; path: string }
  // Long pasted text kept as a chip (not folded into the message). `preview`
  // is the chip label; `content` is the full text — buildUserPrompt reattaches
  // it to the model prompt so the model still receives it.
  | { type: 'pasted'; preview: string; content: string }

/** A file the user attached to a chat turn for the model to read.
 * On attach we write the bytes into the vault's hidden `.octave/attachments/`
 * folder and carry only `path` (vault-relative) — the model Reads it on
 * demand, the same orientation-block channel @-mentions and the viewing
 * file use. No base64 rides through the prompt anymore. */
export interface FileAttachment {
  id: string
  name: string
  mediaType: string
  /** Vault-relative path under `.octave/attachments/` (e.g.
   * `.octave/attachments/<id>/Screenshot.png`). Hidden from the note tree/index
   * (both filter dot-dirs) but Read-able by the agent. */
  path: string
}

export interface ToolCall {
  id: string                       // Anthropic tool_use_id
  name: string
  input: unknown
  result?: { ok: true; markId: string } | { ok: false; reason: string }
}

export const MAX_ACTIVE_THREADS = 5
