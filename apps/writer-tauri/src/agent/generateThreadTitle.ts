// Generates a 3-5 word thread title via Haiku 4.5.
//
// Fire-and-forget: we don't want title generation to block the chat
// response. Failures (network, rate limit, etc.) are silently swallowed
// — the caller is expected to fall back to a 30-char slice of the user
// message if no title comes back in a reasonable time.
//
// The model is told to reply in the same language as the input, so a
// Korean message gets a Korean title, English gets English, etc.

import { anthropic } from '../lib/anthropic'

const MODEL = 'claude-haiku-4-5-20251001'
const MAX_TOKENS = 30

const SYSTEM = `Summarize the user's message into a concise 3-5 word title in the SAME LANGUAGE as the message.

Rules:
- Output only the title text. No quotes, no punctuation, no prefix like "Title:".
- Keep it short — under 30 characters.
- Capture the topic, not the speech act ("ask", "request", etc.).
- Match the language of the user's message exactly.`

export async function generateThreadTitle(userMessage: string): Promise<string | null> {
  const trimmed = userMessage.trim()
  if (!trimmed) return null

  try {
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      messages: [{ role: 'user', content: trimmed }],
    })
    for (const block of resp.content) {
      if (block.type === 'text') {
        const t = block.text.trim().replace(/^["'`]|["'`]$/g, '')
        return t.length > 0 ? t : null
      }
    }
    return null
  } catch (err) {
    console.warn('[generateThreadTitle] failed', err)
    return null
  }
}

// 30-character slice fallback for when title generation fails or is slow.
export function fallbackTitle(userMessage: string): string {
  const t = userMessage.trim().replace(/\s+/g, ' ')
  return t.length <= 30 ? t : t.slice(0, 30) + '…'
}
