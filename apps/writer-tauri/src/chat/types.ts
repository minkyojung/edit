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

/** Models the user can pick from in the PromptInput model selector.
 * Kept narrow + explicit so the UI can display friendly labels without
 * round-tripping through agent ids. The sidecar accepts the raw id. */
export type ChatModel =
  | 'claude-haiku-4-5'
  | 'claude-sonnet-4-6'
  | 'claude-opus-4-8'
  | 'claude-fable-5'

export const CHAT_MODELS: readonly ChatModel[] = [
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-8',
  'claude-fable-5',
] as const

export const CHAT_MODEL_LABELS: Record<ChatModel, string> = {
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-fable-5': 'Fable 5',
}

export const DEFAULT_CHAT_MODEL: ChatModel = 'claude-sonnet-4-6'

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
 * shows where it's real. */
export function modelSupportsFastMode(model: ChatModel): boolean {
  return model === 'claude-opus-4-8'
}

/** Actual fast-mode state the SDK reports on the turn result (`fast_mode_state`)
 * — the truth, not just what we requested: `on` active, `cooldown` temporarily
 * forced off after a rate limit, `off` not enabled. */
export type FastModeState = 'off' | 'cooldown' | 'on'

/** Reasoning effort the model puts into a turn. Mirrors the Claude Agent
 * SDK's first-class `effort` option. `xhigh` is Opus-only — the SDK falls
 * back to `high` on other models, so we only offer it where it's real (see
 * EFFORTS_BY_MODEL). `max` is intentionally not exposed: its token/time cost
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
  'claude-sonnet-4-6': ['low', 'medium', 'high'],
  'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh'],
  'claude-fable-5': ['low', 'medium', 'high', 'xhigh'],
}

export function effortsForModel(model: ChatModel): readonly ChatEffort[] {
  return EFFORTS_BY_MODEL[model]
}

/** Snap an effort to one the model supports, falling back to its highest
 * level. Keeps a thread's stored `xhigh` from leaking into the UI / the SDK
 * call after the user switches to a model that tops out at `high`. */
export function clampEffort(effort: ChatEffort, model: ChatModel): ChatEffort {
  const allowed = EFFORTS_BY_MODEL[model]
  return allowed.includes(effort) ? effort : allowed[allowed.length - 1]
}

export const CHAT_EFFORT_LABELS: Record<ChatEffort, string> = {
  low: 'Fast response',
  medium: 'Balanced',
  high: 'Deep thinking',
  xhigh: 'Maximum thinking',
}

export const DEFAULT_CHAT_EFFORT: ChatEffort = 'medium'

/** Chat interaction mode. `edit` (default) lets the model propose changes;
 * `plan` is read-only — the model explores and writes a plan but cannot
 * propose or apply edits (enforced by permissionMode 'plan' + dropping the
 * propose_* relay tools and Bash for the turn). */
export type ChatMode = 'edit' | 'plan'
export const DEFAULT_CHAT_MODE: ChatMode = 'edit'

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
  /** Slug of the doc this thread is anchored to. Threads always
   * belong to exactly one doc (wiki page / daily / system). When the
   * parent doc is archived the thread follows. The file-based layout
   * uses a flat `threads/` folder, so this field — not directory
   * structure — carries the doc association. */
  parentSlug: string
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

export interface TextPart {
  id: string
  ts: number
  type: 'text'
  text: string
}

export interface ReasoningPart {
  id: string
  ts: number
  type: 'reasoning'
  text: string
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
}

export interface StepStartPart {
  id: string
  ts: number
  type: 'step-start'
}

export type Attachment =
  | { type: 'selection'; from: number; to: number; preview: string }

export interface ToolCall {
  id: string                       // Anthropic tool_use_id
  name: string
  input: unknown
  result?: { ok: true; markId: string } | { ok: false; reason: string }
}

export const MAX_ACTIVE_THREADS = 5
