// Shared types for the chat surface (threads + turns).
// Stored in the document's Y.Doc so they sync across devices via Hocuspocus.

export interface ThreadMeta {
  id: string
  title: string                    // empty until Haiku titler fills it in
  createdAt: number
  updatedAt: number
  archived: boolean
  archivedAt?: number              // for archive popover sort (newest first)
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
