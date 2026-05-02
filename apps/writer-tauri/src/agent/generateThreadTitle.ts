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
- Output only the title text. No quotes, no punctuation, no prefix like "Title:".
- Keep it short — under 30 characters.
- Capture the topic, not the speech act ("ask", "request", etc.).
- Match the language of the user's message exactly.`

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
        const cleaned = text.trim().replace(/^["'`]|["'`]$/g, '')
        settle(cleaned.length > 0 ? cleaned : null)
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
