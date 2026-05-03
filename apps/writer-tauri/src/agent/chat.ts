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
import type {
  ChatTurn,
  MessagePart,
  ReasoningPart,
  TextPart,
  ToolPart,
  UnknownPart,
} from '@/chat/types'
import { useChatRuns } from '@/stores/chatRuns'

const MODEL = 'claude-sonnet-4-6'
const AGENT_ID = 'ai:claude-sonnet'
const DOC_CHAR_CAP = 60_000

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
  /** Prior turns up to AND INCLUDING the user message that triggered this run. */
  history: ChatTurn[]
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
 * message types and we don't strongly type all of them. We pluck the few
 * fields we read from each shape and let the rest fall through to the
 * `unknown` part for debug visibility.
 *
 * Routes:
 * - `stream_event`        → content_block_start/delta/stop, drives live
 *                           text/reasoning/tool-input parts.
 * - `assistant`           → ignored (already covered by stream_event).
 * - `user` w/ tool_result → resolves the matching tool part to its result.
 * - everything else       → surfaced as an `unknown` part.
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
  }
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
  const last = turns[turns.length - 1]
  const prior = turns.slice(0, -1)
  if (prior.length === 0) return last.content

  // Concatenate prior conversation as a transcript. This is a V1 bridge
  // until we plumb Agent SDK session resumption.
  const transcript = prior
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
    .join('\n\n')
  return `Prior conversation:\n${transcript}\n\n---\n\nLatest user message:\n${last.content}`
}

export async function runChat(args: RunChatArgs): Promise<RunChatResult> {
  const { view, ydoc, threadId, history, signal, onTextDelta, onThinkingDelta, onPart, onToolApplied } = args

  const docText = view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n')
  const docForPrompt = docText.length > DOC_CHAR_CAP ? docText.slice(0, DOC_CHAR_CAP) : docText
  const system = `${FREE_CHAT_PROMPT}\n\n--- DOCUMENT ---\n${docForPrompt}`
  const prompt = buildPrompt(history)
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

        // 4) Anything else — keep visible as an unknown part for debugging.
        const unknown: UnknownPart = {
          id: crypto.randomUUID(),
          ts: Date.now(),
          type: 'unknown',
          raw: ev,
        }
        upsertPart(unknown)
      }),
      listen<ProposalEvent>('claude:proposal', (e) => {
        if (e.payload.runId !== runId) return
        const outcome = applyProposal(view, ydoc, e.payload.input, {
          runId,
          agentId: AGENT_ID,
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
          settleErr(err)
        }
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

  try {
    await invoke('claude_chat_start', {
      args: {
        runId,
        model: MODEL,
        systemPrompt: system,
        prompt,
        relayTools: ['propose_change'],
      },
    })
  } catch (e) {
    cleanup()
    throw e
  }

  return finished
}
