// Public types + small helper for the streaming chat runner.
//
// Everything in this module is a pure declaration (or a one-liner
// derivation) so it can be imported from anywhere — the engine
// wiring lives in `./index.ts`, the parser/prompt helpers in their
// own files. Splitting types out keeps the engine file readable
// and lets future modules (e.g. queryWiki) reuse the same
// RunChatArgs shape without dragging the runner in.

import type { EditorView } from '@milkdown/kit/prose/view'
import type {
  ChatTurn,
  MessagePart,
} from '@/chat/types'

/** Sentinel string the Claude Agent SDK uses to split a multi-block
 * system prompt into a cacheable static prefix vs a session-specific
 * dynamic suffix. Mirrors `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` in
 * @anthropic-ai/claude-agent-sdk (sdk.d.ts:5300). Hardcoded here
 * because the frontend doesn't depend on the SDK; the sidecar
 * passes the array through verbatim. */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

export const DEFAULT_MODEL = 'claude-sonnet-4-6'
export const DOC_CHAR_CAP = 60_000

/** Maps Anthropic model id → the agent identifier we stamp on
 * marks created from a turn. The agent id is read by mark UI to
 * attribute proposals. We pass the full id through (e.g.
 * "claude-haiku-4-5-20251001") instead of collapsing it to the
 * family name, so display surfaces can render the family AND the
 * version. formatModel in lib/formatModel.ts handles the
 * user-facing collapse. */
export function agentIdForModel(model: string): string {
  return `ai:${model}`
}

/** One tool invocation observed during a chat turn. Kept generic
 * since Claude Agent SDK's built-in tools (Read / Edit / Write /
 * Grep / Glob / Bash / ...) plus our MCP relays (read_page,
 * search_wiki, submit_ingest_result, submit_profile) all flow
 * through the same toolCalls timeline. `result` is whatever the
 * tool's `tool_result` content block carried back — usually a
 * short status string, occasionally an object. */
export interface ToolCallRecord {
  id: string
  name: string
  input: unknown
  result: unknown
}

export interface RunChatArgs {
  view: EditorView
  /** Slug of the doc this run was started against. Used at proposal-
   * apply time to route to the currently-mounted view (if the user is
   * still on this doc) or to the pending queue (if they've switched
   * away). The captured `view` becomes stale after doc switch since
   * MilkdownEditor unmounts on key change — slug is the stable id. */
  slug: string
  /** Owning thread — runs are aborted as a group when their thread is archived. */
  threadId: string
  /** Prior turns up to AND INCLUDING the user message that triggered this run.
   * Ignored when `prompt` is set directly. */
  history?: ChatTurn[]
  /** Override the user-message prompt entirely. Use this for one-shot
   * instructions like "Begin your review." that don't derive from a chat
   * transcript. */
  prompt?: string
  /** System prompt body. The current document text is appended automatically.
   * Defaults to FREE_CHAT_PROMPT. */
  systemPrompt?: string
  /** Anthropic model id. Defaults to claude-sonnet-4-6. */
  model?: string
  /** Reasoning effort level passed straight to the SDK's first-class
   * `effort` option. Omit to let the SDK pick its default. */
  effort?: 'low' | 'medium' | 'high'
  /** Relay-tool names the sidecar should expose for this run. Defaults to
   * `['propose_change']` so existing callers (free chat, review) keep
   * inline mark editing. Slash commands pass an empty list (or a kind-
   * specific list) to scope the toolset. */
  relayTools?: string[]
  /** When true (default) the document text is appended to the system
   * prompt under a `--- DOCUMENT ---` header. Slash commands that already
   * embed `{{document}}` in their body should pass false to avoid the
   * document showing up twice. */
  appendDocument?: boolean
  signal?: AbortSignal
  /** Convenience callback fired for raw text deltas. New callers should
   * prefer `onPart` and derive content from the parts timeline. */
  onTextDelta?: (delta: string) => void
  /** Convenience callback for thinking-block fragments. */
  onThinkingDelta?: (delta: string) => void
  /** Authoritative callback. Receives a part on every state change — new
   * parts and updated parts come through the same signature. The caller
   * upserts by `part.id` to maintain its own ordered list. */
  onPart?: (part: MessagePart) => void
  onToolApplied?: (call: ToolCallRecord) => void
  /** Authoritative resume hint from the host. True once the SDK has
   * confirmed a session for this thread (set by the runner on the first
   * stream event of the first run, persisted on ThreadMeta). When set we
   * always resume and skip the history-shape heuristic — the heuristic
   * mis-predicts when Regenerate deletes the only assistant turn, making
   * a resumable thread look brand-new and triggering a duplicate-create
   * crash inside the SDK. */
  sessionStarted?: boolean
}

export interface RunChatResult {
  stopReason: string | null
  toolCalls: ToolCallRecord[]
}

/** Snapshot of the most recent SDK rate_limit_event seen during a run.
 * Captured in `runChat`'s closure and re-attached to the rejected Error
 * when the chat fails with code `RATE_LIMIT`, so the UI can render a
 * precise "retry in Ns" countdown instead of a vague "try again". */
export interface ChatErrorRateLimit {
  resetsAt?: number
  rateLimitType?: string
}

// ── Sidecar event payloads ─────────────────────────────────────

/**
 * Loose typing for the SDK notifications we consume — the SDK ships ~30
 * message types and we only model the few that map onto Vercel-style parts.
 *
 * Routes:
 * - `stream_event`        → content_block_start/delta/stop, drives live
 *                           text/reasoning/tool-input parts.
 * - `assistant`           → ignored (already covered by stream_event).
 * - `user` w/ tool_result → resolves the matching tool part to its result.
 * - everything else       → dropped silently (system, rate_limit_event,
 *                           result, …) — these are SDK transport metadata,
 *                           not chat content.
 */
export interface ChatEvent {
  runId: string
  event: {
    type?: string
    // assistant / user — message.content is an array of content blocks
    message?: {
      content?: Array<{
        type: string
        text?: string
        thinking?: string
        // tool_result content block (lives on user messages)
        tool_use_id?: string
        is_error?: boolean
        content?: unknown
      }>
    }
    // stream_event payload (Anthropic's BetaRawMessageStreamEvent)
    event?: {
      type?: string
      index?: number
      content_block?: {
        type?: string
        id?: string
        name?: string
        text?: string
        thinking?: string
      }
      delta?: {
        type?: string
        text?: string
        thinking?: string
        partial_json?: string
      }
    }
    // rate_limit_event — Agent SDK emits this whenever rate-limit state
    // changes (e.g. utilization crosses a threshold, or a request is
    // about to be rejected). Status `'rejected'` means the next chat
    // call will fail with an error code we classify as `RATE_LIMIT`.
    rate_limit_info?: {
      status?: 'allowed' | 'allowed_warning' | 'rejected'
      resetsAt?: number
      rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'overage'
      utilization?: number
    }
  }
}

export interface DoneEvent {
  runId: string
  stopReason: string | null
}

export interface ErrorEvent {
  runId: string
  code: string
  message: string
}
