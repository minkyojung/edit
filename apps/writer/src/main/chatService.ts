import Anthropic from '@anthropic-ai/sdk'
import type { WebContents } from 'electron'
import { getValidToken } from './oauthService'
import { NotAuthenticatedError, isAuthError } from './claudeRuntime'
import { clearToken } from './oauthService'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

let activeAbortController: AbortController | null = null

export async function chat(
  messages: ChatMessage[],
  documentContext: string | null,
  webContents: WebContents
): Promise<void> {
  const token = await getValidToken()
  if (!token) throw new NotAuthenticatedError()

  activeAbortController?.abort()
  activeAbortController = new AbortController()
  const signal = activeAbortController.signal

  const client = new Anthropic({ authToken: token })

  const systemPrompt = documentContext?.trim()
    ? `사용자가 현재 작성 중인 글:\n\n${documentContext}\n\n위 글을 참고해서 사용자의 질문에 답해줘.`
    : undefined

  try {
    const stream = await client.messages.stream(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        messages,
      },
      { signal }
    )

    for await (const event of stream) {
      if (signal.aborted) break
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        if (!webContents.isDestroyed()) {
          webContents.send('chat:chunk', event.delta.text)
        }
      }
    }

    if (!signal.aborted && !webContents.isDestroyed()) {
      webContents.send('chat:done')
    }
  } catch (err) {
    if (signal.aborted) return

    console.error('[chat error]', err)
    if (isAuthError(err)) {
      await clearToken()
      if (!webContents.isDestroyed()) webContents.send('auth:required')
    } else if (!webContents.isDestroyed()) {
      webContents.send('chat:error', err instanceof Error ? err.message : String(err))
    }
  } finally {
    activeAbortController = null
  }
}

export function stopChat(): void {
  activeAbortController?.abort()
  activeAbortController = null
}
