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

interface ChatEvent {
  runId: string
  event: {
    type?: string
    message?: { content?: Array<{ type: string; text?: string; thinking?: string }> }
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
  const { view, ydoc, history, signal, onTextDelta, onThinkingDelta, onToolApplied } = args

  const docText = view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n')
  const docForPrompt = docText.length > DOC_CHAR_CAP ? docText.slice(0, DOC_CHAR_CAP) : docText
  const system = `${FREE_CHAT_PROMPT}\n\n--- DOCUMENT ---\n${docForPrompt}`
  const prompt = buildPrompt(history)
  const runId = crypto.randomUUID()

  const toolCalls: ToolCallRecord[] = []
  let acc = ''
  let thinkingAcc = ''

  const unlistens: UnlistenFn[] = []
  const cleanup = () => {
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
        if (ev?.type === 'assistant') {
          const blocks = ev.message?.content ?? []
          for (const b of blocks) {
            if (b.type === 'text' && typeof b.text === 'string') {
              const next = acc + b.text
              const delta = next.slice(acc.length)
              acc = next
              if (delta) onTextDelta(delta)
            } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
              const next = thinkingAcc + b.thinking
              const delta = next.slice(thinkingAcc.length)
              thinkingAcc = next
              if (delta) onThinkingDelta?.(delta)
            }
          }
        }
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

    if (signal) {
      if (signal.aborted) {
        invoke('claude_chat_cancel', { args: { runId } }).catch(() => {})
        settleErr(new DOMException('aborted', 'AbortError'))
        return
      }
      signal.addEventListener('abort', () => {
        invoke('claude_chat_cancel', { args: { runId } }).catch(() => {})
        // The CANCELLED chat:error notification will arrive and finalize.
      })
    }
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
