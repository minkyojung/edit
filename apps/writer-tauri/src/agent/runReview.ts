// MVP review runner — single-turn Claude call, applies each propose_change
// as an inline mark + Y.Map entry via applyProposal.
//
// Multi-turn loop with search/read_document tools comes in M8.4.

import type { EditorView } from '@milkdown/kit/prose/view'
import * as Y from 'yjs'
import { createMessage } from '../lib/anthropicClient'
import { proposeChangeTool } from './tools'
import { COPYEDITOR_PROMPT } from './skills/copyeditor'
import { applyProposal } from './applyProposal'
import type { Proposal } from './proposals'

const MODEL = 'claude-haiku-4-5-20251001'
const MAX_TOKENS = 4096
const AGENT_ID = 'ai:claude-haiku'
const DOC_CHAR_CAP = 60_000 // mirrors proof-sdk's style-review cap

interface RunReviewResult {
  proposed: number
  applied: number
  skipped: Array<{ proposal: Proposal; reason: string }>
  raw: unknown
}

export async function runReview(view: EditorView, ydoc: Y.Doc): Promise<RunReviewResult> {
  const docText = view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n')
  if (!docText.trim()) {
    console.warn('[runReview] empty document — nothing to review')
    return { proposed: 0, applied: 0, skipped: [], raw: null }
  }

  const truncated = docText.length > DOC_CHAR_CAP
  const docForPrompt = truncated ? docText.slice(0, DOC_CHAR_CAP) : docText
  if (truncated) {
    console.warn(`[runReview] doc truncated from ${docText.length} → ${DOC_CHAR_CAP} chars`)
  }

  const system = `${COPYEDITOR_PROMPT}\n\n--- DOCUMENT ---\n${docForPrompt}`

  console.log('[runReview] calling Claude…', { docLen: docForPrompt.length })
  const response = await createMessage({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    tools: [proposeChangeTool],
    messages: [{ role: 'user', content: 'Begin your review.' }],
  } as Parameters<typeof createMessage>[0])

  const proposals: Proposal[] = []
  for (const block of (response as { content: Array<Record<string, unknown>> }).content) {
    if (block.type !== 'tool_use' || block.name !== 'propose_change') continue
    proposals.push(block.input as Proposal)
  }

  console.log(`[runReview] received ${proposals.length} proposal(s)`)

  const runId = crypto.randomUUID()
  const skipped: Array<{ proposal: Proposal; reason: string }> = []
  let applied = 0
  for (const p of proposals) {
    const outcome = applyProposal(view, ydoc, p, { runId, agentId: AGENT_ID })
    if (outcome.ok) {
      applied++
    } else {
      skipped.push({ proposal: p, reason: outcome.reason })
    }
  }

  console.log(`[runReview] applied ${applied}/${proposals.length}; skipped`, skipped)
  return { proposed: proposals.length, applied, skipped, raw: response }
}
