// Generates a thread title via the title sidecar.
//
// Fire-and-forget: failures (auth, network, timeout) resolve to null so the
// caller can fall back to `fallbackTitle`. The caller MUST do that — a null
// left unhandled is a tab that reads "New chat" for the life of the thread,
// because nothing retries.
//
// WHAT a title looks like is not decided here. The prompt, the tool
// constraints, and the language rule all live in the sidecar's title mode
// (`TITLE_SYSTEM_PROMPT` in sidecar/src/server.mjs), because the prompt alone
// did not hold: sent from this side with no toolset constraint, the model got
// the full claude_code preset and answered the message instead of titling it.
// The two terms only work together, so they live together — and
// `verify-thread-title` can then drive the real ones.

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { ChatEvent, DoneEvent, ErrorEvent } from '@/agent/chat/types'
import {
  parseChatEvent,
  parseDoneEvent,
  parseErrorEvent,
} from '@/agent/chat/eventSchemas'

const MODEL = 'claude-haiku-4-5'

// Every title run cold-spawns a `claude` CLI subprocess, so this is not a
// network round-trip: measured 6-8s alone, and 14.8s for the slowest of three
// started together (verify-thread-title). 15s sat inside that spread and turned
// "two new chats at once" into a coin flip, so it is set clear of the measured
// worst case rather than at it.
const TIMEOUT_MS = 25_000

const TITLE_MAX_CHARS = 30

export async function generateThreadTitle(userMessage: string): Promise<string | null> {
  const trimmed = userMessage.trim()
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
        if (!parseChatEvent(e.payload) || e.payload.runId !== runId) return
        const ev = e.payload.event
        if (ev?.type !== 'assistant') return
        for (const b of ev.message?.content ?? []) {
          if (b.type === 'text' && typeof b.text === 'string') {
            text += b.text
          }
        }
      }),
      listen<DoneEvent>('claude:done', (e) => {
        if (!parseDoneEvent(e.payload) || e.payload.runId !== runId) return
        clearTimeout(timer)
        // Take the first non-empty line, strip wrapping quotes, collapse
        // whitespace, then hard-cap length. Haiku occasionally returns a
        // multi-line answer or a full sentence despite the prompt — caller
        // sets this string directly as the thread title, so we must enforce
        // brevity here rather than trusting the model.
        const firstLine = text.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0) ?? ''
        const cleaned = firstLine
          .replace(/^["'`]+|["'`]+$/g, '')
          .replace(/\s+/g, ' ')
          .trim()
        const capped =
          cleaned.length > TITLE_MAX_CHARS
            ? cleaned.slice(0, TITLE_MAX_CHARS).trimEnd() + '…'
            : cleaned
        settle(capped.length > 0 ? capped : null)
      }),
      listen<ErrorEvent>('claude:error', (e) => {
        if (!parseErrorEvent(e.payload) || e.payload.runId !== runId) return
        clearTimeout(timer)
        settle(null)
      }),
    ])
      .then((registered) => {
        unlistens.push(...registered)
        return invoke('claude_title', {
          args: { runId, model: MODEL, prompt: trimmed },
        })
      })
      .catch((err) => {
        console.warn('[generateThreadTitle] failed', err)
        clearTimeout(timer)
        settle(null)
      })
  })
}

/** 30-character slice of the message itself, for when generation fails or is
 *  slow. Wired at the call site (ChatPanel) — this used to be exported and
 *  called from nowhere, while two comments claimed it was "in place", so a
 *  failed title left the tab reading "New chat" permanently. */
export function fallbackTitle(userMessage: string): string {
  const t = userMessage.trim().replace(/\s+/g, ' ')
  return t.length <= 30 ? t : t.slice(0, 30) + '…'
}
