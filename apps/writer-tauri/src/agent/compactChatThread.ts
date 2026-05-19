// Compacts a single chat thread into entity-bullet form so the ingest
// LLM can treat it as a fact source alongside the daily body. Mirrors
// the `claude_title` sidecar pattern used by `generateAiSummary.ts`
// — single-shot Haiku call, no streaming, no tool relay.
//
// Output shape (intentional):
//   - Sarah: 디자인팀 합류 결정
//   - Sarah: 다음 분기 PM 후보로 거론됨
//   - 라뱃 데모: 5월 마지막 주 데모 데이로 확정
//
// One bullet per (entity, fact). Ingest already extracts entity+bullets
// from raw daily text, so handing it pre-shaped bullets means no second
// transformation pass — the LLM picks them up verbatim or merges them
// into existing wiki pages.
//
// Result lands on `ThreadMeta.aiSummary` keyed by `aiSummaryUpToTurnId`
// (the last turn id covered). Subsequent ingests re-call this only when
// the thread has new turns since the cached summary.

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import * as Y from 'yjs'
import type { ChatTurn, ThreadMeta } from '@/chat/types'

const MODEL = 'claude-haiku-4-5'
const TIMEOUT_MS = 15_000
const SUMMARY_MAX_CHARS = 2_000

const SYSTEM = `Compact this chat thread into a list of facts about specific entities (people, projects, concepts).

Rules:
- One bullet per (entity, fact). Format: "- <entity>: <fact>".
- Match the language used in the thread (Korean stays Korean, English stays English).
- Only include facts the user clearly stated or that the assistant confirmed — skip speculation, hypotheticals, and questions.
- Skip pleasantries, restated questions, and meta-conversation ("let me know if…").
- Prefer concrete state changes ("Sarah joined the design team") over discussion topics ("we talked about Sarah's role").
- If the thread contains no extractable facts, output a single line: "(no extractable facts)".
- Output ONLY the bullet list. No preamble, no closing remarks.`

interface ChatEvent {
  runId: string
  event: {
    type?: string
    message?: { content?: Array<{ type: string; text?: string }> }
  }
}

interface DoneEvent {
  runId: string
}

interface ErrorEvent {
  runId: string
  code: string
  message: string
}

/** Build a plain-text transcript from a thread's turns. user/assistant
 * labels prefix each turn so the model knows who said what. Empty
 * turns are dropped — they're either still streaming or were stopped
 * before producing content. */
function buildTranscript(turns: ChatTurn[]): string {
  return turns
    .filter((t) => t.content.trim().length > 0)
    .map((t) => `${t.role === 'user' ? 'USER' : 'ASSISTANT'}: ${t.content.trim()}`)
    .join('\n\n')
}

/** Drive the claude_title sidecar with a compaction prompt. Returns
 * the trimmed bullet list or null on any failure (timeout, sidecar
 * error, empty model output). Mirrors callSummarizer in
 * `generateAiSummary.ts` — same event wiring, same timeout shape. */
async function callCompactor(transcript: string): Promise<string | null> {
  const trimmed = transcript.trim()
  if (!trimmed) return null

  const runId = crypto.randomUUID()
  let text = ''
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

  return new Promise<string | null>((resolve) => {
    let done = false
    const settle = (val: string | null) => {
      if (done) return
      done = true
      cleanup()
      resolve(val)
    }

    const timer = setTimeout(() => settle(null), TIMEOUT_MS)

    Promise.all([
      listen<ChatEvent>('claude:event', (e) => {
        if (e.payload.runId !== runId) return
        const ev = e.payload.event
        if (ev?.type !== 'assistant') return
        for (const b of ev.message?.content ?? []) {
          if (b.type === 'text' && typeof b.text === 'string') {
            text += b.text
          }
        }
      }),
      listen<DoneEvent>('claude:done', (e) => {
        if (e.payload.runId !== runId) return
        clearTimeout(timer)
        const cleaned = text.trim()
        if (!cleaned) return settle(null)
        const truncated =
          cleaned.length > SUMMARY_MAX_CHARS
            ? cleaned.slice(0, SUMMARY_MAX_CHARS).trimEnd() + '…'
            : cleaned
        settle(truncated)
      }),
      listen<ErrorEvent>('claude:error', (e) => {
        if (e.payload.runId !== runId) return
        clearTimeout(timer)
        settle(null)
      }),
    ])
      .then((registered) => {
        unlistens.push(...registered)
        return invoke('claude_title', {
          args: { runId, model: MODEL, systemPrompt: SYSTEM, prompt: trimmed },
        })
      })
      .catch((err) => {
        console.warn('[compactChat] invoke failed', err)
        clearTimeout(timer)
        settle(null)
      })
  })
}

/** Persist the summary back onto ThreadMeta in the thread's parent ydoc.
 * Y.Array has no in-place update, so we splice-replace at the same
 * index inside a single 'chat-meta' transaction — same pattern
 * `useThreads.renameThread` uses. The 'chat-meta' origin keeps the
 * write off the UndoManager (chat turns aren't part of the document
 * undo stack). */
function persistSummary(
  ydoc: Y.Doc,
  threadId: string,
  summary: string,
  upToTurnId: string,
): void {
  const yThreads = ydoc.getArray<ThreadMeta>('threads')
  const arr = yThreads.toArray()
  const idx = arr.findIndex((t) => t.id === threadId)
  if (idx < 0) return
  const prev = arr[idx]
  ydoc.transact(() => {
    yThreads.delete(idx, 1)
    yThreads.insert(idx, [
      { ...prev, aiSummary: summary, aiSummaryUpToTurnId: upToTurnId },
    ])
  }, 'chat-meta')
}

/** Public entry. Reads the thread's turns from the given ydoc, calls
 * the compactor, persists the result back onto ThreadMeta, and
 * returns the summary string (or null on failure / empty thread).
 *
 * Fire-and-forget at the call site: any failure leaves the existing
 * aiSummary untouched. Ingest treats absence/staleness symmetrically
 * — it'll retry on the next pass. */
export async function compactChatThread(
  ydoc: Y.Doc,
  threadId: string,
): Promise<string | null> {
  const yTurns = ydoc.getArray<ChatTurn>(`thread:${threadId}`)
  const turns = yTurns.toArray()
  if (turns.length === 0) return null

  const transcript = buildTranscript(turns)
  if (!transcript) return null

  const summary = await callCompactor(transcript)
  if (!summary) return null

  const lastTurnId = turns[turns.length - 1].id
  try {
    persistSummary(ydoc, threadId, summary, lastTurnId)
    console.log('[compactChat] cached', { threadId, turns: turns.length, chars: summary.length })
  } catch (err) {
    console.warn('[compactChat] persist failed', { threadId, err })
  }
  return summary
}
