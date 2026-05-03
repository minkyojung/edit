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
import type { ChatTurn } from '@/chat/types'
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
  onTextDelta: (delta: string) => void
  /** Called for every thinking-block text fragment the model emits. */
  onThinkingDelta?: (delta: string) => void
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
 * Subset of the SDK's notification shapes we react to. The SDK can emit ~30
 * different message types; we only render text/thinking deltas today.
 *
 * - `stream_event` carries Anthropic's raw streaming events (token-by-token
 *   content_block_delta), surfaced because the sidecar runs query() with
 *   includePartialMessages: true.
 * - `assistant` is the post-stream summary message (whole reply at once);
 *   we still see it, but the live text already came from stream_event.
 */
interface ChatEvent {
  runId: string
  event: {
    type?: string
    // assistant message
    message?: { content?: Array<{ type: string; text?: string; thinking?: string }> }
    // stream_event payload (BetaRawMessageStreamEvent)
    event?: {
      type?: string
      delta?: {
        type?: string
        text?: string
        thinking?: string
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
  const { view, ydoc, threadId, history, signal, onTextDelta, onThinkingDelta, onToolApplied } = args

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
        // Token-by-token streaming. The SDK forwards Anthropic's raw stream
        // events; we only care about content_block_delta of text or thinking.
        if (ev?.type === 'stream_event') {
          const inner = ev.event
          if (inner?.type === 'content_block_delta') {
            const d = inner.delta
            if (d?.type === 'text_delta' && d.text) onTextDelta(d.text)
            else if (d?.type === 'thinking_delta' && d.thinking) onThinkingDelta?.(d.thinking)
          }
          return
        }
        // The SDK still emits a final `assistant` summary message after the
        // stream completes. We already accumulated everything via stream_event,
        // so ignore the duplicate here.
        if (ev?.type === 'assistant') return
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
