// Shared types for the chat surface (threads + turns).
// Stored in the document's Y.Doc so they sync across devices via Hocuspocus.

/** Models the user can pick from in the PromptInput model selector.
 * Kept narrow + explicit so the UI can display friendly labels without
 * round-tripping through agent ids. The sidecar accepts the raw id. */
export type ChatModel = 'claude-haiku-4-5' | 'claude-sonnet-4-6' | 'claude-opus-4-7'

export const CHAT_MODELS: readonly ChatModel[] = [
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-7',
] as const

export const CHAT_MODEL_LABELS: Record<ChatModel, string> = {
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-opus-4-7': 'Opus 4.7',
}

export const DEFAULT_CHAT_MODEL: ChatModel = 'claude-sonnet-4-6'

/** Reasoning effort the model puts into a turn. Mirrors the Claude Agent
 * SDK's first-class `effort` option (we expose its 3 most common levels;
 * `xhigh` / `max` are skipped as they're Opus-specific). */
export type ChatEffort = 'low' | 'medium' | 'high'

export const CHAT_EFFORTS: readonly ChatEffort[] = ['low', 'medium', 'high'] as const

export const CHAT_EFFORT_LABELS: Record<ChatEffort, string> = {
  low: 'Fast response',
  medium: 'Balanced',
  high: 'Deep thinking',
}

/** Per-ring opacity tuple [inner, middle, outer] for the EffortButton's
 * concentric-circle target icon — the rings fill outward as effort
 * increases. */
export const CHAT_EFFORT_OPACITIES: Record<ChatEffort, [number, number, number]> = {
  low: [1, 0.2, 0.2],
  medium: [1, 1, 0.2],
  high: [1, 1, 1],
}

export const DEFAULT_CHAT_EFFORT: ChatEffort = 'medium'

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
