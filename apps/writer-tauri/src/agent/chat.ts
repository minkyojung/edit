// Streaming chat runner — multi-turn loop with the propose_change tool.
//
// Flow per iteration:
//   1. anthropic.messages.stream() with the conversation so far
//   2. text deltas → onTextDelta() (live streaming into the assistant turn)
//   3. on stream completion, inspect the assembled message:
//        - if no tool_use blocks, we're done
//        - if there are tool_use blocks, apply each via applyProposal,
//          push assistant + tool_result messages, loop again
//   4. cap at MAX_TOOL_LOOPS to keep runaway calls bounded
//
// Cancellation is via AbortSignal: the SDK forwards it to our tauriFetch,
// which invokes claude_cancel in Rust to drop the upstream request.

import type { EditorView } from '@milkdown/kit/prose/view'
import * as Y from 'yjs'
import type {
  MessageParam,
  ContentBlockParam,
} from '@anthropic-ai/sdk/resources/messages'
import { anthropic } from '../lib/anthropic'
import { proposeChangeTool } from './tools'
import { FREE_CHAT_PROMPT } from './skills/freeChat'
import { applyProposal, type ApplyOutcome } from './applyProposal'
import type { Proposal } from './proposals'
import type { ChatTurn } from '@/chat/types'

const MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS = 4096
const AGENT_ID = 'ai:claude-sonnet'
const DOC_CHAR_CAP = 60_000
const MAX_TOOL_LOOPS = 5

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
  onToolApplied?: (call: ToolCallRecord) => void
}

export interface RunChatResult {
  stopReason: string | null
  toolCalls: ToolCallRecord[]
}

export async function runChat({
  view,
  ydoc,
  history,
  signal,
  onTextDelta,
  onToolApplied,
}: RunChatArgs): Promise<RunChatResult> {
  const docText = view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n')
  const docForPrompt = docText.length > DOC_CHAR_CAP ? docText.slice(0, DOC_CHAR_CAP) : docText
  const system = `${FREE_CHAT_PROMPT}\n\n--- DOCUMENT ---\n${docForPrompt}`

  // Convert ChatTurn history → Anthropic messages. Skip empty assistant
  // placeholders (we add one *after* this call kicks off, but it should be
  // filtered upstream too).
  let messages: MessageParam[] = history
    .filter((t) => t.content.trim().length > 0)
    .map((t) => ({ role: t.role, content: t.content }))

  const runId = crypto.randomUUID()
  const allToolCalls: ToolCallRecord[] = []
  let stopReason: string | null = null

  for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
    const stream = anthropic.messages.stream(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        tools: [proposeChangeTool] as Parameters<typeof anthropic.messages.create>[0]['tools'],
        messages,
      },
      { signal },
    )

    stream.on('text', (delta) => onTextDelta(delta))

    const final = await stream.finalMessage()
    stopReason = final.stop_reason ?? null

    const toolUseBlocks = final.content.filter((b) => b.type === 'tool_use')
    if (toolUseBlocks.length === 0) break

    const toolResults: ContentBlockParam[] = []
    for (const block of toolUseBlocks) {
      if (block.type !== 'tool_use') continue
      let outcome: ApplyOutcome
      if (block.name === 'propose_change') {
        outcome = applyProposal(view, ydoc, block.input as Proposal, {
          runId,
          agentId: AGENT_ID,
        })
      } else {
        outcome = { ok: false, reason: `unknown_tool:${block.name}` }
      }

      const record: ToolCallRecord = {
        id: block.id,
        name: block.name,
        input: block.input,
        result: outcome,
      }
      allToolCalls.push(record)
      onToolApplied?.(record)

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: outcome.ok ? `applied as mark ${outcome.markId}` : `failed: ${outcome.reason}`,
        is_error: !outcome.ok,
      })
    }

    // Feed assistant + tool_results back for the next turn so the model
    // can acknowledge / continue / stop.
    messages = [
      ...messages,
      { role: 'assistant', content: final.content },
      { role: 'user', content: toolResults },
    ]

    if (stopReason === 'end_turn') break
  }

  return { stopReason, toolCalls: allToolCalls }
}
