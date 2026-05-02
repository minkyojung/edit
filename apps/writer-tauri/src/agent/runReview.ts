// Run Review — bulk copyedit pass over the document.
//
// Drives the chat sidecar with the COPYEDITOR_PROMPT and consumes proposal
// events as they arrive. Each chat/proposal turns into an applyProposal
// call, so marks appear in the editor progressively rather than in one
// batch at the end.

import type { EditorView } from '@milkdown/kit/prose/view'
import * as Y from 'yjs'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { COPYEDITOR_PROMPT } from './skills/copyeditor'
import { applyProposal } from './applyProposal'
import type { Proposal } from './proposals'

const MODEL = 'claude-haiku-4-5'
const AGENT_ID = 'ai:claude-haiku'
const DOC_CHAR_CAP = 60_000 // mirrors proof-sdk's style-review cap

export interface AppliedProposal {
  markId: string
  proposal: Proposal
  by: string
}

export interface RunReviewResult {
  proposed: number
  applied: AppliedProposal[]
  skipped: Array<{ proposal: Proposal; reason: string }>
}

interface ProposalEvent {
  runId: string
  input: Proposal
}

interface DoneEvent {
  runId: string
}

interface ErrorEvent {
  runId: string
  code: string
  message: string
}

interface ChatEvent {
  runId: string
  event: {
    type?: string
    message?: { content?: Array<{ type: string; text?: string; thinking?: string }> }
  }
}

export interface RunReviewArgs {
  view: EditorView
  ydoc: Y.Doc
  /** Called for every thinking-block fragment the model emits. */
  onThinkingDelta?: (delta: string) => void
  /** Called once per applied proposal, in arrival order. */
  onProposalApplied?: (applied: AppliedProposal) => void
}

export async function runReview(args: RunReviewArgs): Promise<RunReviewResult> {
  const { view, ydoc, onThinkingDelta, onProposalApplied } = args
  const docText = view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n')
  if (!docText.trim()) {
    console.warn('[runReview] empty document — nothing to review')
    return { proposed: 0, applied: [], skipped: [] }
  }

  const truncated = docText.length > DOC_CHAR_CAP
  const docForPrompt = truncated ? docText.slice(0, DOC_CHAR_CAP) : docText
  if (truncated) {
    console.warn(`[runReview] doc truncated from ${docText.length} → ${DOC_CHAR_CAP} chars`)
  }

  const system = `${COPYEDITOR_PROMPT}\n\n--- DOCUMENT ---\n${docForPrompt}`
  const runId = crypto.randomUUID()

  const applied: AppliedProposal[] = []
  const skipped: Array<{ proposal: Proposal; reason: string }> = []
  let proposedCount = 0

  const unlistens: UnlistenFn[] = []
  const cleanup = () => {
    while (unlistens.length > 0) {
      try {
        unlistens.pop()?.()
      } catch {
        // already detached
      }
    }
  }

  const finished = new Promise<RunReviewResult>((resolve, reject) => {
    let settled = false
    const settleOk = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ proposed: proposedCount, applied, skipped })
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
        if (ev?.type !== 'assistant') return
        for (const b of ev.message?.content ?? []) {
          if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) {
            onThinkingDelta?.(b.thinking)
          }
        }
      }),
      listen<ProposalEvent>('claude:proposal', (e) => {
        if (e.payload.runId !== runId) return
        proposedCount += 1
        const proposal = e.payload.input
        const outcome = applyProposal(view, ydoc, proposal, { runId, agentId: AGENT_ID })
        if (outcome.ok) {
          const record = { markId: outcome.markId, proposal, by: AGENT_ID }
          applied.push(record)
          onProposalApplied?.(record)
        } else {
          skipped.push({ proposal, reason: outcome.reason })
        }
      }),
      listen<DoneEvent>('claude:done', (e) => {
        if (e.payload.runId !== runId) return
        settleOk()
      }),
      listen<ErrorEvent>('claude:error', (e) => {
        if (e.payload.runId !== runId) return
        settleErr(new Error(`${e.payload.code}: ${e.payload.message}`))
      }),
    ])
      .then((registered) => {
        unlistens.push(...registered)
      })
      .catch((err) => settleErr(err))
  })

  try {
    await invoke('claude_chat_start', {
      args: {
        runId,
        model: MODEL,
        systemPrompt: system,
        prompt: 'Begin your review.',
        relayTools: ['propose_change'],
      },
    })
  } catch (err) {
    cleanup()
    throw err
  }

  return finished
}
