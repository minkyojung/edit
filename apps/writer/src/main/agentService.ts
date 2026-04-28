import { query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk'
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { WebContents } from 'electron'
import { readBelief } from './wikiService'

class UserMessageQueue {
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

const COPYEDITOR_INSTRUCTIONS = `You are a copyeditor embedded in a writing app.
The user will send you their writing. Analyze it and return concise, actionable suggestions to improve clarity, flow, and style.
Keep suggestions brief. Output in Korean if the writing is in Korean.
Do not rewrite the entire text — give specific targeted suggestions only.
Apply the user's writing style preferences from the wiki section above when making suggestions.`

let session: Query | null = null
let queue: UserMessageQueue | null = null
let activeWebContents: WebContents | null = null

function extractText(msg: SDKMessage): string | null {
  if (msg.type !== 'assistant') return null
  const textBlock = msg.message.content.find((b) => b.type === 'text')
  return textBlock && textBlock.type === 'text' ? textBlock.text : null
}

async function ensureSession(webContents: WebContents): Promise<void> {
  if (session) return

  const belief = await readBelief()

  queue = new UserMessageQueue()
  activeWebContents = webContents

  session = query({
    prompt: queue as AsyncIterable<unknown> as Parameters<typeof query>[0]['prompt'],
    options: {
      model: 'claude-haiku-4-5',
      systemPrompt: [
        '## 사용자 글쓰기 스타일 (위키)\n\n' + belief,
        COPYEDITOR_INSTRUCTIONS,
        SYSTEM_PROMPT_DYNAMIC_BOUNDARY
      ],
      permissionMode: 'dontAsk',
      tools: [],
      settingSources: ['user', 'project', 'local']
    }
  })

  processStream().catch((err) => console.error('[agent stream]', err))
}

async function processStream(): Promise<void> {
  if (!session) return

  try {
    for await (const msg of session) {
      if ('isReplay' in msg && (msg as { isReplay?: boolean }).isReplay) continue

      if (msg.type === 'system' && msg.subtype === 'init') {
        console.log('[agent] session started:', msg.session_id)
        continue
      }

      if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
        console.log('[agent] compaction:', msg.compact_metadata.pre_tokens, '→', msg.compact_metadata.post_tokens)
        continue
      }

      const text = extractText(msg)
      if (text && activeWebContents && !activeWebContents.isDestroyed()) {
        activeWebContents.send('agent:chunk', text)
      }

      if (msg.type === 'result') {
        if (activeWebContents && !activeWebContents.isDestroyed()) {
          activeWebContents.send('agent:done')
        }
      }
    }
  } catch (err) {
    console.error('[agent error]', err)
  } finally {
    session = null
    queue = null
    activeWebContents = null
  }
}

export function trigger(text: string, webContents: WebContents): void {
  ensureSession(webContents)
    .then(() => {
      activeWebContents = webContents
      queue?.push({ type: 'user', message: { role: 'user', content: text } })
    })
    .catch((err) => console.error('[trigger]', err))
}

export async function resetSession(): Promise<void> {
  if (session) {
    try {
      await session.interrupt()
    } catch {
      // ignore
    }
  }
  queue?.close()
  session = null
  queue = null
  activeWebContents = null
}

export async function shutdown(): Promise<void> {
  await resetSession()
}
