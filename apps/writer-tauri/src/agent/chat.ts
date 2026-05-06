// Streaming chat runner — drives a single chat turn through the Tauri
// sidecar. The sidecar wraps Anthropic's Agent SDK (`query()`), which
// internally handles tool execution; we only consume the resulting
// notifications:
//
//   claude:event    → assistant text blocks (accumulated, emitted as deltas)
//   claude:proposal → propose_change payload (we apply the mark locally)
//   claude:done     → end of turn
//   claude:error    → upstream failure or cancellation
//
// V1 multi-turn handling: prior conversation is concatenated into the prompt
// as a transcript. This loses Agent SDK prompt-cache efficiency; a follow-up
// can switch to session resumption (resumeSessionId) to fix that.

import type { EditorView } from '@milkdown/kit/prose/view'
import * as Y from 'yjs'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { FREE_CHAT_PROMPT } from './skills/freeChat'
import { applyProposal, type ApplyOutcome } from './applyProposal'
import type { Proposal } from './proposals'
import { readWikiContext } from '@/state/wikiService'

// Sentinel string the Claude Agent SDK uses to split a multi-block
// system prompt into a cacheable static prefix vs a session-specific
// dynamic suffix. Mirrors `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` in
// @anthropic-ai/claude-agent-sdk (sdk.d.ts:5300). Hardcoded here
// because the frontend doesn't depend on the SDK; the sidecar passes
// the array through verbatim.
const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
import type {
  ChatTurn,
  MessagePart,
  ReasoningPart,
  TextPart,
  ToolPart,
} from '@/chat/types'
import { useChatRuns } from '@/stores/chatRuns'

const DEFAULT_MODEL = 'claude-sonnet-4-6'
const DOC_CHAR_CAP = 60_000

// Maps Anthropic model id → the agent identifier we stamp on marks created
// from a turn. The agent id is read by mark UI to attribute proposals.
function agentIdForModel(model: string): string {
  if (model.includes('haiku')) return 'ai:claude-haiku'
  if (model.includes('opus')) return 'ai:claude-opus'
  return 'ai:claude-sonnet'
}

export interface ToolCallRecord {
  id: string
  name: string
  input: unknown
  result: ApplyOutcome
}

export interface RunChatArgs {
  view: EditorView
  ydoc: Y.Doc
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
}

export interface RunChatResult {
  stopReason: string | null
  toolCalls: ToolCallRecord[]
}

interface ProposalEvent {
  runId: string
  input: Proposal
}

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
interface ChatEvent {
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

/** Snapshot of the most recent SDK rate_limit_event seen during a run.
 * Captured in `runChat`'s closure and re-attached to the rejected Error
 * when the chat fails with code `RATE_LIMIT`, so the UI can render a
 * precise "retry in Ns" countdown instead of a vague "try again". */
export interface ChatErrorRateLimit {
  resetsAt?: number
  rateLimitType?: string
}

interface DoneEvent {
  runId: string
  stopReason: string | null
}

interface ErrorEvent {
  runId: string
  code: string
  message: string
}

/** Best-effort error text extraction from a tool_result content block.
 * Anthropic returns content as either a plain string, a single text block,
 * or an array of blocks; we handle all three. */
function extractErrorText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const text = content
      .map((b) => (typeof b === 'object' && b && 'text' in b ? String((b as { text?: unknown }).text ?? '') : ''))
      .join('')
    return text || undefined
  }
  return undefined
}

function buildPrompt(history: ChatTurn[]): string {
  const turns = history.filter((t) => t.content.trim().length > 0)
  if (turns.length === 0) return ''
  // SDK session resume keeps prior turns server-side — we only send
  // the latest user message. Older revisions concatenated a
  // transcript here; that broke prompt-cache reuse and was
  // explicitly flagged as a temporary bridge.
  return turns[turns.length - 1].content
}

/** True when the conversation has at least one assistant turn already.
 * Used to pick between the `sessionId` (first turn) and `resume`
 * (subsequent) SDK options so we don't try to resume a session that
 * doesn't exist yet, and don't try to create one that does. */
function shouldResumeSession(history: ChatTurn[] | undefined): boolean {
  if (!history) return false
  return history.some((t) => t.role === 'assistant')
}

export async function runChat(args: RunChatArgs): Promise<RunChatResult> {
  const {
    view,
    ydoc,
    threadId,
    history,
    prompt: promptOverride,
    systemPrompt,
    model = DEFAULT_MODEL,
    effort: effortOverride,
    relayTools = ['propose_change'],
    appendDocument = true,
    signal,
    onTextDelta,
    onThinkingDelta,
    onPart,
    onToolApplied,
  } = args
  const agentId = agentIdForModel(model)

  // Effort default: Haiku is the copyeditor lane (short, latency-
  // sensitive turns) → 'low'. Sonnet/Opus are the chat lane → 'medium'.
  // Caller's explicit choice always wins.
  const effort: 'low' | 'medium' | 'high' =
    effortOverride ?? (model.includes('haiku') ? 'low' : 'medium')

  const docText = view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n')
  const docForPrompt = docText.length > DOC_CHAR_CAP ? docText.slice(0, DOC_CHAR_CAP) : docText
  const systemBody = systemPrompt ?? FREE_CHAT_PROMPT

  // Read the user's wiki context (belief + entity + episode) so it
  // can be prepended to the system prompt as the cacheable prefix.
  // Empty when no wiki page has content yet — assembly handles that
  // cleanly. Read errors collapse to '' (proof-server unreachable)
  // so a chat is never blocked on the wiki round-trip.
  const wikiContext = await readWikiContext()

  // System prompt assembly — the SDK accepts either a single string
  // or string[] with a boundary marker. We prefer the array form
  // when there's a meaningful split between cacheable prefix
  // (wiki context, role) and dynamic suffix (current document text).
  // No wiki + no document → fall back to a single string.
  let system: string | string[]
  if (wikiContext && appendDocument) {
    system = [
      wikiContext,
      systemBody,
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      `--- DOCUMENT ---\n${docForPrompt}`,
    ]
  } else if (wikiContext) {
    // Wiki context but no document (slash commands that bake doc into the body).
    system = [wikiContext, systemBody]
  } else if (appendDocument) {
    // No wiki content yet, but document follows the role prompt.
    system = [
      systemBody,
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      `--- DOCUMENT ---\n${docForPrompt}`,
    ]
  } else {
    system = systemBody
  }
  const prompt = promptOverride ?? buildPrompt(history ?? [])
  const runId = crypto.randomUUID()

  // Internal controller is the single source of abort — it bridges the
  // (optional) caller-supplied signal AND the central chatRuns registry,
  // so an abort from either side fans out the same way.
  const controller = new AbortController()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  const runs = useChatRuns.getState()
  runs.start(threadId, runId, controller)

  const toolCalls: ToolCallRecord[] = []

  // Mutable mirror of the parts timeline — kept locally so we can update an
  // existing part (e.g. append a text delta) by reading its prior state and
  // re-emitting the new whole. The caller treats `part.id` as identity and
  // upserts.
  const partsById = new Map<string, MessagePart>()
  // index → partId for the open content_block at that index. Anthropic's
  // raw stream uses an index per concurrent block; we route deltas via this.
  const blockIndexToPartId = new Map<number, string>()
  // Tool input arrives as fragments of JSON via input_json_delta. We keep
  // the partial string per part until content_block_stop, then JSON.parse.
  const toolInputFragments = new Map<string, string>()
  // Most recent SDK rate_limit_event observed during the run. Re-attached
  // to a rejected Error if the run fails with `RATE_LIMIT` so the UI can
  // render a precise countdown (`resetsAt`).
  let lastRateLimitInfo: ChatEvent['event']['rate_limit_info'] | undefined

  const upsertPart = (part: MessagePart) => {
    partsById.set(part.id, part)
    onPart?.(part)
  }
  const findToolPartByCallId = (toolCallId: string): ToolPart | undefined => {
    for (const p of partsById.values()) {
      if (p.type === 'tool' && p.toolCallId === toolCallId) return p
    }
    return undefined
  }

  const unlistens: UnlistenFn[] = []
  const cleanup = () => {
    useChatRuns.getState().end(runId)
    while (unlistens.length > 0) {
      const u = unlistens.pop()
      try {
        u?.()
      } catch {
        // listeners are best-effort; an already-detached one is fine
      }
    }
  }

  const finished = new Promise<RunChatResult>((resolve, reject) => {
    let settled = false
    const settleOk = (stopReason: string | null) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ stopReason, toolCalls })
    }
    const settleErr = (err: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    Promise.all([
      listen<ChatEvent>('claude:event', (e) => {
        if (e.payload.runId !== runId) return
        const ev = e.payload.event

        // 1) Live token streaming — Anthropic's raw content_block_* events.
        if (ev?.type === 'stream_event') {
          const inner = ev.event
          // Block opens — register a part of the right type at this index.
          if (inner?.type === 'content_block_start') {
            const idx = inner.index ?? 0
            const block = inner.content_block ?? {}
            const partId = crypto.randomUUID()
            const ts = Date.now()
            if (block.type === 'text') {
              const part: TextPart = { id: partId, ts, type: 'text', text: block.text ?? '' }
              blockIndexToPartId.set(idx, partId)
              upsertPart(part)
            } else if (block.type === 'thinking') {
              const part: ReasoningPart = { id: partId, ts, type: 'reasoning', text: block.thinking ?? '' }
              blockIndexToPartId.set(idx, partId)
              upsertPart(part)
            } else if (block.type === 'tool_use') {
              const part: ToolPart = {
                id: partId,
                ts,
                type: 'tool',
                toolName: block.name ?? '<unknown>',
                toolCallId: block.id ?? partId,
                input: {},
                state: 'input-streaming',
              }
              blockIndexToPartId.set(idx, partId)
              toolInputFragments.set(partId, '')
              upsertPart(part)
            }
            return
          }

          // Deltas — append to whichever block is open at this index.
          if (inner?.type === 'content_block_delta') {
            const idx = inner.index ?? 0
            const partId = blockIndexToPartId.get(idx)
            const d = inner.delta
            if (partId && d) {
              const prev = partsById.get(partId)
              if (prev?.type === 'text' && d.type === 'text_delta' && d.text) {
                upsertPart({ ...prev, text: prev.text + d.text })
                onTextDelta?.(d.text)
              } else if (prev?.type === 'reasoning' && d.type === 'thinking_delta' && d.thinking) {
                upsertPart({ ...prev, text: prev.text + d.thinking })
                onThinkingDelta?.(d.thinking)
              } else if (prev?.type === 'tool' && d.type === 'input_json_delta' && d.partial_json) {
                const buf = (toolInputFragments.get(partId) ?? '') + d.partial_json
                toolInputFragments.set(partId, buf)
                // Don't try to parse mid-stream; just keep the raw fragment
                // visible via input until stop.
                upsertPart({ ...prev, input: buf })
              }
            }
            return
          }

          // Block closes — for tool_use, parse accumulated JSON and flip state.
          if (inner?.type === 'content_block_stop') {
            const idx = inner.index ?? 0
            const partId = blockIndexToPartId.get(idx)
            blockIndexToPartId.delete(idx)
            if (partId) {
              const prev = partsById.get(partId)
              if (prev?.type === 'tool') {
                const buf = toolInputFragments.get(partId) ?? ''
                toolInputFragments.delete(partId)
                let parsed: unknown = buf
                try { parsed = buf ? JSON.parse(buf) : {} } catch { /* leave raw string */ }
                upsertPart({ ...prev, input: parsed, state: 'input-available' })
              }
            }
            return
          }
          return
        }

        // 2) Final assistant message — already covered by stream_event.
        if (ev?.type === 'assistant') return

        // 3) User message with tool_result — resolve the matching tool part.
        if (ev?.type === 'user') {
          const blocks = ev.message?.content
          if (Array.isArray(blocks)) {
            for (const b of blocks) {
              if (b.type === 'tool_result' && b.tool_use_id) {
                const tool = findToolPartByCallId(b.tool_use_id)
                if (tool) {
                  const isError = !!b.is_error
                  upsertPart({
                    ...tool,
                    state: isError ? 'output-error' : 'output-available',
                    output: b.content,
                    errorText: isError ? extractErrorText(b.content) : undefined,
                  })
                }
              }
            }
          }
          return
        }

        // 4) Rate-limit info — the SDK fires this whenever its view of
        // the user's rate-limit state changes. We snapshot the latest one
        // so the eventual error path can attach a precise `resetsAt` to
        // the rejected Error (UI uses it to drive a countdown).
        if (ev?.type === 'rate_limit_event' && ev.rate_limit_info) {
          lastRateLimitInfo = ev.rate_limit_info
          return
        }

        // 5) Everything else (system, result, …) — SDK transport metadata,
        // not chat content. The Vercel `parts` model only carries
        // text/reasoning/tool/source/file/step-*, so we mirror that and
        // drop anything outside the whitelist on the floor. If we ever
        // need to surface a new content type, add a route above.
      }),
      listen<ProposalEvent>('claude:proposal', (e) => {
        if (e.payload.runId !== runId) return
        const outcome = applyProposal(view, ydoc, e.payload.input, {
          runId,
          agentId,
        })
        const record: ToolCallRecord = {
          id: crypto.randomUUID(),
          name: 'propose_change',
          input: e.payload.input,
          result: outcome,
        }
        toolCalls.push(record)
        onToolApplied?.(record)
      }),
      listen<DoneEvent>('claude:done', (e) => {
        if (e.payload.runId !== runId) return
        settleOk(e.payload.stopReason)
      }),
      listen<ErrorEvent>('claude:error', (e) => {
        if (e.payload.runId !== runId) return
        if (e.payload.code === 'CANCELLED') {
          settleErr(new DOMException(e.payload.message, 'AbortError'))
        } else {
          const err = new Error(`${e.payload.code}: ${e.payload.message}`)
          // For rate-limit failures, attach the most recent SDK rate_limit
          // snapshot so the renderer can drive a precise countdown. The
          // info travels as a non-enumerable property to keep `Error`
          // serialization predictable.
          if (e.payload.code === 'RATE_LIMIT' && lastRateLimitInfo) {
            // SDK reports `resetsAt` in seconds since epoch. The UI side
            // works in ms (Date.now() math) so we normalize at the boundary.
            const resetsAtSec = lastRateLimitInfo.resetsAt
            ;(err as Error & { rateLimit?: ChatErrorRateLimit }).rateLimit = {
              resetsAt: typeof resetsAtSec === 'number' ? resetsAtSec * 1000 : undefined,
              rateLimitType: lastRateLimitInfo.rateLimitType,
            }
          }
          settleErr(err)
        }
      }),
      // Sidecar process death. The Rust supervisor emits this on child exit
      // (before attempting restart). Without it, in-flight runs hang waiting
      // on chat:event / chat:done that will never arrive — the producer is
      // gone. We settle as a regular error so the UI shows a retry card.
      listen<{ mode: string }>('sidecar:died', (e) => {
        if (e.payload.mode !== 'chat') return
        settleErr(new Error('SIDECAR_DIED: chat sidecar crashed'))
      }),
    ])
      .then((registered) => {
        unlistens.push(...registered)
      })
      .catch((err) => settleErr(err))

    if (controller.signal.aborted) {
      invoke('claude_chat_cancel', { args: { runId } }).catch(() => {})
      settleErr(new DOMException('aborted', 'AbortError'))
      return
    }
    controller.signal.addEventListener('abort', () => {
      invoke('claude_chat_cancel', { args: { runId } }).catch(() => {})
      // The CANCELLED chat:error notification will arrive and finalize.
    })
  })

  // Map our threadId 1:1 to the SDK's session UUID. First turn of a
  // thread creates the session via `sessionId`; later turns load it
  // via `resume`. Doing both at once is invalid (without forkSession)
  // so we pick exactly one based on whether an assistant has spoken
  // yet. Persisted server-side under ~/.claude/projects/ so the
  // session survives app restarts.
  const isResume = shouldResumeSession(history)
  try {
    await invoke('claude_chat_start', {
      args: {
        runId,
        model,
        systemPrompt: system,
        prompt,
        relayTools,
        effort,
        sessionId: isResume ? undefined : threadId,
        resume: isResume ? threadId : undefined,
      },
    })
  } catch (e) {
    cleanup()
    throw e
  }

  return finished
}
