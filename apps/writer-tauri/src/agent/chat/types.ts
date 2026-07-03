// Public types + small helper for the streaming chat runner.
//
// Everything in this module is a pure declaration (or a one-liner
// derivation) so it can be imported from anywhere — the engine
// wiring lives in `./index.ts`, the parser/prompt helpers in their
// own files. Splitting types out keeps the engine file readable
// and lets future modules (e.g. queryWiki) reuse the same
// RunChatArgs shape without dragging the runner in.

import type {
  ChatTurn,
  FileAttachment,
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

/** A visualization the user armed for editing (via the ✎ toolbar, or by
 * selecting a viz block). When present on a run, the agent is given the
 * edit_visualization relay tool and told the target's id + current spec, so
 * "make it a bar chart" edits THAT block in place — same session, no separate
 * pipeline. `source` is the block's current spec JSON. */
export interface VizEditTarget {
  id: string
  source: string
}

export interface RunChatArgs {
  /** The chat's "current page" text. The Read Later queue passes a generated
   * article list here; otherwise runChat reads the open doc's bodyMarkdown
   * cache by slug. */
  pageContextMarkdown?: string
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
  /** Files the user attached to this turn. Converted to Anthropic
   * ContentBlock[] alongside the text prompt in buildUserContent().
   * Not stored in ChatTurn (too large for JSONL); lives only in the
   * live run path. Ignored when `prompt` is set directly (slash cmds). */
  attachments?: FileAttachment[]
  /** System prompt body. The current document text is appended automatically.
   * Defaults to FREE_CHAT_PROMPT. */
  systemPrompt?: string
  /** Anthropic model id. Defaults to claude-sonnet-4-6. */
  model?: string
  /** Reasoning effort level passed straight to the SDK's first-class
   * `effort` option. `xhigh` is Opus-only; the SDK falls back to `high` on
   * other models. Omit to let the SDK pick its default. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh'
  /** Request fast mode (faster output) for this run — forwarded to the SDK's
   * `settings.fastMode`. Only honored on models that support it; the caller
   * gates on modelSupportsFastMode before setting it. Omit/false = off. */
  fastMode?: boolean
  /** Relay-tool names the sidecar should expose for this run. Defaults to
   * `['propose_change']` so existing callers (free chat, review) keep
   * inline mark editing. Slash commands pass an empty list (or a kind-
   * specific list) to scope the toolset. */
  relayTools?: string[]
  /** Permission mode forwarded to the SDK.
   * - `'default'` — normal chat: the sidecar's canUseTool gate fires so the
   *   model can pause on AskUserQuestion; every other tool passes through.
   * - `'plan'` — read-only planning turn; the SDK blocks tool execution and
   *   the caller also drops the propose_* relays + Bash.
   * Omit only for non-chat callers (e.g. ingest) that want the sidecar's
   * bypassPermissions default. */
  permissionMode?: 'plan' | 'default' | 'acceptEdits'
  /** acceptEdits mode: auto-accept each proposed change the instant it lands
   * (apply without waiting for a manual Keep). The diff still renders — now as
   * an already-applied change. Default false → edits stay pending for review. */
  autoAcceptEdits?: boolean
  /** Built-in SDK tool names to expose. Omit for the edit default
   * (Read/Glob/Grep/Bash). Plan turns pass ['Read','Glob','Grep']. */
  builtinTools?: string[]
  /** When true (default) the document text is appended to the system
   * prompt under a `--- DOCUMENT ---` header. Slash commands that already
   * embed `{{document}}` in their body should pass false to avoid the
   * document showing up twice. */
  appendDocument?: boolean
  /** Vault-relative path of a non-markdown file the user is viewing in the
   * FileViewer (`/file/:rel`) route — a PDF, image, audio, etc. There's no
   * editor/slug for these, so this is the only signal the agent gets that a
   * file is open. Injected into the system prompt with an instruction to
   * Read it on demand (the SDK's Read tool ingests PDFs/images natively).
   * Null/omitted on every other surface. */
  viewingFilePath?: string | null
  /** Editor text the user had selected when sending a free-chat turn. Injected
   * as a `--- SELECTION ---` block so "explain this" targets the selection. Only
   * passed for free chat — slash commands embed selection via `{{selection}}`. */
  selectionText?: string | null
  /** Vault-relative paths the user @-mentioned in the composer. Injected as a
   * `--- REFERENCED FILES ---` orientation block (like viewingFilePath) so the
   * agent Reads them on demand — kept out of the visible user message. */
  mentionPaths?: string[]
  /** When set, this run is editing a specific visualization: the agent gets
   * the edit_visualization relay tool and the target's id + current spec are
   * injected into the system prompt. Omit for normal turns. */
  vizEditTarget?: VizEditTarget
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
  /** Fired once, on the FIRST claude:event of any kind for this run — the
   * SDK's session-init signal, which lands before any content part. The caller
   * marks the thread's session as started here (not on the first content part)
   * so a first turn that fails mid-think — after the SDK created the session
   * but before any text streamed — still flips the resume flag and avoids a
   * duplicate-create on the next run. */
  onSessionStart?: () => void
  /** Authoritative resume hint from the host. True once the SDK has
   * confirmed a session for this thread (set by the runner on the first
   * stream event of the first run, persisted on ThreadMeta). When set we
   * always resume and skip the history-shape heuristic — the heuristic
   * mis-predicts when Regenerate deletes the only assistant turn, making
   * a resumable thread look brand-new and triggering a duplicate-create
   * crash inside the SDK. */
  sessionStarted?: boolean
  /** When true, navigate the editor to a note the agent CREATES this run
   * (a `propose_write` to a path that didn't exist yet) so its inline
   * green/red preview is immediately visible. Interactive surfaces set this;
   * headless ingest (runIntake) leaves it off so background runs don't hijack
   * the user's current view. Only newly-created notes navigate — edits to
   * existing notes keep the click-to-jump suggestion card. */
  navigateToNewNotes?: boolean
}

export interface RunChatResult {
  stopReason: string | null
  /** Number of edits this run staged, derived at settle from the single
   * source of truth — the PendingChanges pushed under this run's id.
   * Consumed by the review-comments summarize hook. */
  editCount: number
}

/** Snapshot of the most recent SDK rate_limit_event seen during a run.
 * Captured in `runChat`'s closure and re-attached to the rejected Error
 * when the chat fails with code `RATE_LIMIT`, so the UI can render a
 * precise "retry in Ns" countdown instead of a vague "try again". */
export interface ChatErrorRateLimit {
  /** ms-epoch when the limit resets (normalized from the SDK's seconds). */
  resetsAt?: number
  rateLimitType?: string
  /** Why overage/paid usage is unavailable — e.g. 'out_of_credits'. Lets the
   * card distinguish "out of credits" from a plain windowed rate limit. */
  overageDisabledReason?: string
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
    // system messages carry a subtype (e.g. 'compact_boundary', 'task_progress')
    subtype?: string
    // compact_boundary — the SDK summarized earlier turns to fit the window
    compact_metadata?: {
      trigger?: 'manual' | 'auto'
      pre_tokens?: number
      post_tokens?: number
    }
    // task_started / task_progress — subagent heartbeat. `tool_use_id` links
    // back to the Task tool_use part this progress belongs to.
    tool_use_id?: string
    description?: string
    last_tool_name?: string
    // task_progress — an AI-generated present-tense progress line for the
    // running subagent (agentProgressSummaries), e.g. "Analyzing the outline".
    summary?: string
    usage?: {
      total_tokens?: number
      tool_uses?: number
      duration_ms?: number
    }
    // subagent events carry the parent Task's tool_use id (null on main thread)
    parent_tool_use_id?: string | null
    // Stable per-message id (SDKAssistantMessage.uuid). Keys a subagent
    // message's child parts so re-emitted snapshots upsert, not duplicate.
    uuid?: string
    // assistant messages may carry a structured API-level error
    // (SDKAssistantMessageError) — the sidecar maps it to a chat/error code.
    // Also reused by system/api_retry as the triggering error label.
    error?: string
    // system/api_retry — the SDK auto-retries a transient error (429/5xx)
    // after a back-off; surfaced as a transient "Retrying…" row.
    attempt?: number
    max_retries?: number
    retry_delay_ms?: number
    // assistant / user — message.content is an array of content blocks
    message?: {
      content?: Array<{
        type: string
        text?: string
        thinking?: string
        // tool_use content block (lives on assistant messages)
        id?: string
        name?: string
        input?: unknown
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
  /** Token usage for the final result of the turn. The sidecar
   * (server.mjs chat/done) already emits this from the SDK result
   * message; the context gauge derives its post-turn total from it.
   * STEP 3 will add a richer `contextUsage` breakdown sourced from
   * query.getContextUsage(). */
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  } | null
  totalCostUsd?: number | null
  /** STEP 3: exact per-category context breakdown from the sidecar's
   * query.getContextUsage() call, when available. `maxTokens` and
   * `autoCompactThreshold` are token counts (the threshold is the point
   * at which auto-compaction triggers). Null when the control request
   * failed — the gauge then falls back to the `usage` totals. */
  contextUsage?: {
    totalTokens: number
    maxTokens: number
    model?: string
    categories?: Array<{
      name: string
      tokens: number
      color?: string
      isDeferred?: boolean
    }>
    autoCompactThreshold?: number
  } | null
  /** Actual fast-mode state for the turn, read from the SDK result's
   * `fast_mode_state`. `cooldown` means a rate limit forced it off even though
   * it was requested. Null when the SDK didn't report it. */
  fastModeState?: 'off' | 'cooldown' | 'on' | null
}

export interface ErrorEvent {
  runId: string
  code: string
  message: string
  /** Whether retrying the same request could succeed. Drives whether the
   * error card shows a Retry button. Absent → treated as retryable. */
  retryable?: boolean
  /** For `code === 'RATE_LIMIT'`: the SDK's reset info, sourced sidecar-side
   * from `rate_limit_event`. `resetsAt` is SECONDS since epoch (normalized to
   * ms at the host boundary). Lets the card show the right window + countdown. */
  rateLimit?: {
    resetsAt?: number
    rateLimitType?: string
    overageDisabledReason?: string
  }
}
