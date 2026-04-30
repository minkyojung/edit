import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk'
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { WebContents } from 'electron'
import { authedQuery, NotAuthenticatedError } from './claudeRuntime'

export interface ChatFile {
  url: string
  mediaType: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  files?: ChatFile[]
}

class ChatQueue {
  private _q: unknown[] = []
  private _waiters: ((msg: unknown) => void)[] = []
  private _closed = false

  push(msg: unknown): void {
    if (this._closed) return
    if (this._waiters.length) this._waiters.shift()!(msg)
    else this._q.push(msg)
  }

  close(): void {
    this._closed = true
    this._waiters.forEach((w) => w(null))
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    while (true) {
      if (this._q.length) yield this._q.shift()
      else if (this._closed) return
      else {
        const m = await new Promise<unknown>((r) => this._waiters.push(r))
        if (m === null) return
        else yield m
      }
    }
  }
}

function buildMessageContent(
  text: string,
  files: ChatFile[] | undefined,
  documentContext: string | null
): unknown {
  const textBody = documentContext?.trim()
    ? `<document>\n${documentContext}\n</document>\n\n${text}`
    : text

  const images = (files ?? []).filter((f) => f.mediaType.startsWith('image/'))

  if (images.length === 0) return textBody

  const parts: unknown[] = images.map((f) => {
    const base64 = f.url.split(',')[1] ?? ''
    return {
      type: 'image',
      source: { type: 'base64', media_type: f.mediaType, data: base64 },
    }
  })

  if (textBody) parts.push({ type: 'text', text: textBody })

  return parts
}

const CHAT_SYSTEM_PROMPT = `You are a helpful writing assistant. Help the user with questions about their writing, provide feedback, and answer general questions. Respond in the same language the user writes in.`

let session: Query | null = null
let queue: ChatQueue | null = null
let activeWebContents: WebContents | null = null
let sessionInit: Promise<void> | null = null

function extractText(msg: SDKMessage): string | null {
  if (msg.type !== 'assistant') return null
  const textBlock = msg.message.content.find((b) => b.type === 'text')
  return textBlock && textBlock.type === 'text' ? textBlock.text : null
}

async function processStream(): Promise<void> {
  if (!session) return

  try {
    for await (const msg of session) {
      if ('isReplay' in msg && (msg as { isReplay?: boolean }).isReplay) continue

      const text = extractText(msg)
      if (text && activeWebContents && !activeWebContents.isDestroyed()) {
        activeWebContents.send('chat:chunk', text)
      }

      if (msg.type === 'result') {
        if (activeWebContents && !activeWebContents.isDestroyed()) {
          activeWebContents.send('chat:done')
        }
      }
    }
  } catch (err) {
    console.error('[chat stream error]', err)
    if (activeWebContents && !activeWebContents.isDestroyed()) {
      activeWebContents.send('chat:error', err instanceof Error ? err.message : String(err))
      activeWebContents.send('chat:done')
    }
  } finally {
    session = null
    queue = null
    activeWebContents = null
  }
}

async function ensureSession(webContents: WebContents): Promise<void> {
  if (session) return
  if (sessionInit) return sessionInit

  sessionInit = (async () => {
    queue = new ChatQueue()
    activeWebContents = webContents

    try {
      session = await authedQuery({
        prompt: queue as AsyncIterable<unknown> as Parameters<typeof authedQuery>[0]['prompt'],
        options: {
          model: 'claude-sonnet-4-6',
          systemPrompt: [CHAT_SYSTEM_PROMPT, SYSTEM_PROMPT_DYNAMIC_BOUNDARY],
          permissionMode: 'bypassPermissions',
          settingSources: []
        }
      })
    } catch (err) {
      session = null
      queue = null
      activeWebContents = null
      throw err
    }

    processStream().catch((err) => console.error('[chat stream]', err))
  })().finally(() => {
    sessionInit = null
  })

  return sessionInit
}

export async function chat(
  messages: ChatMessage[],
  documentContext: string | null,
  webContents: WebContents
): Promise<void> {
  try {
    await ensureSession(webContents)
  } catch (err) {
    if (err instanceof NotAuthenticatedError) {
      if (!webContents.isDestroyed()) {
        webContents.send('chat:error', 'unauthenticated')
        webContents.send('chat:done')
      }
      return
    }
    throw err
  }

  activeWebContents = webContents

  const lastUserMsg = messages[messages.length - 1]
  if (!lastUserMsg || lastUserMsg.role !== 'user') return

  const content = buildMessageContent(lastUserMsg.content, lastUserMsg.files, documentContext)

  queue?.push({ type: 'user', message: { role: 'user', content } })
}

export async function stopChat(): Promise<void> {
  try {
    await session?.interrupt()
  } catch {
    // ignore
  }
  queue?.close()
  if (activeWebContents && !activeWebContents.isDestroyed()) {
    activeWebContents.send('chat:done')
  }
  session = null
  queue = null
  activeWebContents = null
  sessionInit = null
}
