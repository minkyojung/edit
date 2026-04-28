import { query } from '@anthropic-ai/claude-agent-sdk'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { WebContents } from 'electron'

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

const SYSTEM_PROMPT = `You are a copyeditor embedded in a writing app.
The user will send you their writing. Analyze it and return concise, actionable suggestions to improve clarity, flow, and style.
Keep suggestions brief. Output in Korean if the writing is in Korean.
Do not rewrite the entire text — give specific targeted suggestions only.`

let queue: UserMessageQueue | null = null
let running = false

function extractText(msg: SDKMessage): string | null {
  if (msg.type !== 'assistant') return null
  const textBlock = msg.message.content.find((b) => b.type === 'text')
  return textBlock && textBlock.type === 'text' ? textBlock.text : null
}

export function trigger(text: string, webContents: WebContents): void {
  if (queue) {
    // 세션이 살아있으면 메시지만 push
    queue.push({ type: 'user', message: { role: 'user', content: text } })
    return
  }

  if (running) return

  // 새 세션 시작: 큐를 먼저 만들고 첫 메시지 push 후 query 시작
  queue = new UserMessageQueue()
  queue.push({ type: 'user', message: { role: 'user', content: text } })

  runSession(webContents)
}

async function runSession(webContents: WebContents): Promise<void> {
  running = true

  const q = query({
    prompt: queue as AsyncIterable<unknown> as Parameters<typeof query>[0]['prompt'],
    options: {
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: SYSTEM_PROMPT
      },
      permissionMode: 'dontAsk',
      tools: [],
      settingSources: ['user', 'project', 'local']
    }
  })

  try {
    for await (const msg of q) {
      if ('isReplay' in msg && (msg as { isReplay?: boolean }).isReplay) continue

      if (msg.type === 'system' && msg.subtype === 'init') {
        console.log('[agent] session started:', msg.session_id)
        continue
      }

      const text = extractText(msg)
      if (text) {
        console.log('[agent chunk]', text.slice(0, 80))
        webContents.send('agent:chunk', text)
      }

      if (msg.type === 'result') {
        console.log('[agent] done')
        webContents.send('agent:done')
      }
    }
  } catch (err) {
    console.error('[agent error]', err)
  } finally {
    running = false
    queue = null
  }
}
