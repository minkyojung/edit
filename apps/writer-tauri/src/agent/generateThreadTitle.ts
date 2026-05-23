// Generates a 3-5 word thread title via the title sidecar.
//
// Fire-and-forget: failures (auth, network, timeout) resolve to null so
// the caller can keep the slug-style fallbackTitle in place.
//
// The model is told to reply in the same language as the input, so a
// Korean message gets a Korean title, English gets English, etc.

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

const MODEL = 'claude-haiku-4-5'
const TIMEOUT_MS = 15_000

const SYSTEM = `Summarize the user's message into a concise 3-5 word title in the SAME LANGUAGE as the message.

Rules:
- Output only the title text on a single line. No quotes, no punctuation, no prefix like "Title:".
- Keep it short — at most 6 words AND under 24 characters total.
- Capture the topic noun phrase, not the speech act ("ask", "request", "tell me", etc.).
- No greetings, no sentences. Title form only.
- Match the language of the user's message exactly.`

const TITLE_MAX_CHARS = 30

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
        console.warn('[generateThreadTitle] failed', err)
        clearTimeout(timer)
        settle(null)
      })
  })
}

// 30-character slice fallback for when title generation fails or is slow.
export function fallbackTitle(userMessage: string): string {
  const t = userMessage.trim().replace(/\s+/g, ' ')
  return t.length <= 30 ? t : t.slice(0, 30) + '…'
}
