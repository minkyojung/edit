import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { authedQuery, NotAuthenticatedError, isAuthError } from './claudeRuntime'
import { clearToken, onAuthChange } from './oauthService'

onAuthChange((status) => {
  if (status === 'unauthenticated') {
    resetSession().catch((err) => console.error('[agent] reset on logout failed', err))
  }
})
import type { WebContents } from 'electron'
import { z } from 'zod'
import { readBelief } from './wikiService'
import { scheduleMemoryUpdate } from './memoryService'
import { bootstrapDoc } from './docService'
import * as sessionStore from './agentSessionStore'
import * as settingsStore from './agentSettings'
import type { AgentSettings } from './agentSettings'
import { PROOF_URL, withMutationBaseRetry, type MutationBase } from './proofClient'

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
Read the user's writing and emit suggestion marks via the suggest_* tools. Do NOT respond with plain-text explanations.

Available tools:
- suggest_replace(quote, content): replace exact text "quote" with "content"
- suggest_insert(quote, content): insert "content" at the position of "quote" (quote stays)
- suggest_delete(quote): delete the exact text "quote"

Rules:
- Quote MUST match the original text exactly (including punctuation, whitespace, and case).
- WHITESPACE HANDLING — when a phrase is surrounded by spaces in the original, INCLUDE the leading or trailing space inside the quote so the result has clean spacing after the change.
  - "그는 매우 정말로 빠르게 달린다" → suggest_delete("매우 정말로 ") (note trailing space included; result: "그는 빠르게 달린다")
  - suggest_replace("매우 정말로 빠르게", "빠르게") works only if the surrounding text doesn't introduce double spaces. If unsure, include the surrounding space in the quote.
  - For replacement: include trailing/leading space in BOTH quote and content if needed for natural flow.
- Group adjacent edits into a single suggestion when they form one logical change. Avoid splitting "쓰는 편입니다" into two separate marks.
- Choose the right tool: if changing wording → replace; if adding extra words → insert; if removing → delete.
- Keep suggestions short and targeted; avoid sweeping rewrites.
- Apply the user's writing style preferences from the wiki section above.
- Output in Korean if the writing is in Korean.
- If no improvements are needed, do nothing.`

async function callSuggestApi(
  slug: string,
  token: string,
  kind: 'replace' | 'insert' | 'delete',
  body: Record<string, string>
): Promise<{ ok: boolean; status: number; error?: string }> {
  const submit = (base: MutationBase): Promise<Response> =>
    fetch(`${PROOF_URL}/api/agent/${slug}/marks/suggest-${kind}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-share-token': token
      },
      body: JSON.stringify({ ...body, by: 'ai:copyeditor', ...base })
    })
  try {
    const res = await withMutationBaseRetry(slug, token, submit, `suggest-${kind}`)
    return { ok: true, status: res.status }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 0, error: message }
  }
}

async function createSuggestServer(slug: string, token: string): Promise<ReturnType<typeof createSdkMcpServer>> {
  return createSdkMcpServer({
    name: 'suggest',
    version: '0.0.1',
    tools: [
      tool(
        'suggest_replace',
        '문서 안의 특정 문구를 다른 표현으로 바꾸는 제안 마크를 추가한다. quote는 원문에 정확히 일치해야 한다.',
        { quote: z.string(), content: z.string() },
        async ({ quote, content }) => {
          const r = await callSuggestApi(slug, token, 'replace', { quote, content })
          if (!r.ok) {
            console.error('[suggest_replace] failed:', r.status, r.error)
            return { content: [{ type: 'text', text: `failed: ${r.status} ${r.error}` }] }
          }
          console.log('[suggest_replace]', quote, '→', content)
          return { content: [{ type: 'text', text: 'ok' }] }
        }
      ),
      tool(
        'suggest_insert',
        '문서 안의 특정 문구 위치에 새 텍스트를 추가하는 제안 마크. quote는 원문에 정확히 일치하는 앵커, content는 추가할 새 텍스트.',
        { quote: z.string(), content: z.string() },
        async ({ quote, content }) => {
          const r = await callSuggestApi(slug, token, 'insert', { quote, content })
          if (!r.ok) {
            console.error('[suggest_insert] failed:', r.status, r.error)
            return { content: [{ type: 'text', text: `failed: ${r.status} ${r.error}` }] }
          }
          console.log('[suggest_insert]', quote, '+', content)
          return { content: [{ type: 'text', text: 'ok' }] }
        }
      ),
      tool(
        'suggest_delete',
        '문서 안의 특정 문구를 지우는 제안 마크. quote는 원문에 정확히 일치해야 한다.',
        { quote: z.string() },
        async ({ quote }) => {
          const r = await callSuggestApi(slug, token, 'delete', { quote })
          if (!r.ok) {
            console.error('[suggest_delete] failed:', r.status, r.error)
            return { content: [{ type: 'text', text: `failed: ${r.status} ${r.error}` }] }
          }
          console.log('[suggest_delete]', quote)
          return { content: [{ type: 'text', text: 'ok' }] }
        }
      )
    ]
  })
}

let session: Query | null = null
let queue: UserMessageQueue | null = null
let activeWebContents: WebContents | null = null
let conversationLog: string[] = []
let sessionInit: Promise<void> | null = null
let currentSettings: AgentSettings = settingsStore.DEFAULT_SETTINGS
let settingsLoaded: Promise<void> | null = null

function ensureSettingsLoaded(): Promise<void> {
  if (!settingsLoaded) {
    settingsLoaded = settingsStore.load().then((s) => {
      currentSettings = s
    })
  }
  return settingsLoaded
}

function extractText(msg: SDKMessage): string | null {
  if (msg.type !== 'assistant') return null
  const textBlock = msg.message.content.find((b) => b.type === 'text')
  return textBlock && textBlock.type === 'text' ? textBlock.text : null
}

async function ensureSession(webContents: WebContents): Promise<void> {
  if (session) return
  if (sessionInit) return sessionInit

  sessionInit = (async () => {
    await ensureSettingsLoaded()

    let belief = ''
    try {
      belief = await readBelief()
    } catch (err) {
      console.error('[agent] readBelief failed, continuing with empty belief:', err)
    }

    const doc = await bootstrapDoc()
    const suggestServer = await createSuggestServer(doc.slug, doc.token)
    const savedSessionId = await sessionStore.load()

    queue = new UserMessageQueue()
    activeWebContents = webContents

    try {
      session = await authedQuery({
        prompt: queue as AsyncIterable<unknown> as Parameters<typeof authedQuery>[0]['prompt'],
        options: {
          model: currentSettings.model,
          effort: currentSettings.effort,
          resume: savedSessionId ?? undefined,
          systemPrompt: [
            '## 사용자 글쓰기 스타일 (위키)\n\n' + belief,
            COPYEDITOR_INSTRUCTIONS,
            SYSTEM_PROMPT_DYNAMIC_BOUNDARY
          ],
          mcpServers: { suggest: suggestServer },
          allowedTools: [
            'mcp__suggest__suggest_replace',
            'mcp__suggest__suggest_insert',
            'mcp__suggest__suggest_delete'
          ],
          tools: [
            'mcp__suggest__suggest_replace',
            'mcp__suggest__suggest_insert',
            'mcp__suggest__suggest_delete'
          ],
          permissionMode: 'bypassPermissions',
          settingSources: []
        }
      })
    } catch (err) {
      if (err instanceof NotAuthenticatedError) {
        if (!webContents.isDestroyed()) webContents.send('auth:required')
        session = null
        queue = null
        activeWebContents = null
        return
      }
      throw err
    }

    processStream().catch((err) => console.error('[agent stream]', err))
  })().finally(() => {
    sessionInit = null
  })

  return sessionInit
}

async function processStream(): Promise<void> {
  if (!session) return

  try {
    for await (const msg of session) {
      if ('isReplay' in msg && (msg as { isReplay?: boolean }).isReplay) continue

      if (msg.type === 'system' && msg.subtype === 'init') {
        console.log('[agent] session started:', msg.session_id)
        sessionStore.save(msg.session_id).catch((err) =>
          console.error('[agent] sessionStore.save failed', err)
        )
        continue
      }

      if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
        console.log('[agent] compaction:', msg.compact_metadata.pre_tokens, '→', msg.compact_metadata.post_tokens)
        continue
      }

      const text = extractText(msg)
      if (text) {
        if (activeWebContents && !activeWebContents.isDestroyed()) {
          activeWebContents.send('agent:chunk', text)
        }
        conversationLog.push(`Assistant: ${text}`)
      }

      if (msg.type === 'result') {
        if (activeWebContents && !activeWebContents.isDestroyed()) {
          activeWebContents.send('agent:done')
        }
        if (conversationLog.length > 0) {
          scheduleMemoryUpdate(conversationLog.join('\n\n'))
          conversationLog = []
        }
      }
    }
  } catch (err) {
    console.error('[agent error]', err)
    await sessionStore.clear()
    if (isAuthError(err)) {
      await clearToken()
      if (activeWebContents && !activeWebContents.isDestroyed()) {
        activeWebContents.send('auth:required')
      }
    } else if (activeWebContents && !activeWebContents.isDestroyed()) {
      activeWebContents.send('agent:error', err instanceof Error ? err.message : String(err))
      activeWebContents.send('agent:done')
    }
  } finally {
    session = null
    queue = null
    activeWebContents = null
  }
}

type ProcessedHistoryItem = {
  status?: unknown
  kind?: unknown
  quote?: unknown
  content?: unknown
}

function formatProcessedHistory(items: unknown[]): string {
  if (!Array.isArray(items) || items.length === 0) return ''
  const lines: string[] = []
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as ProcessedHistoryItem
    const status = typeof item.status === 'string' ? item.status : null
    const kind = typeof item.kind === 'string' ? item.kind : null
    const quote = typeof item.quote === 'string' ? item.quote : null
    if (!status || !kind || !quote) continue
    if (status !== 'accepted' && status !== 'rejected') continue
    const content = typeof item.content === 'string' ? item.content : null
    const detail =
      kind === 'replace' && content !== null
        ? `replace "${quote}" → "${content}"`
        : kind === 'insert' && content !== null
          ? `insert "${content}" at "${quote}"`
          : kind === 'delete'
            ? `delete "${quote}"`
            : `${kind} "${quote}"`
    lines.push(`- (${status}) ${detail}`)
  }
  if (lines.length === 0) return ''
  return [
    '<processed_suggestions>',
    '사용자가 이미 다음 제안들을 처리했음. 같은 인용(quote)에 대해 같은 종류의 제안을 다시 만들지 마세요. 거절된 제안은 사용자가 동의하지 않은 것이므로 같은 의도의 다른 형태도 피하세요.',
    ...lines,
    '</processed_suggestions>'
  ].join('\n')
}

export function trigger(
  text: string,
  webContents: WebContents,
  processedHistory: unknown[] = []
): void {
  ensureSession(webContents)
    .then(() => {
      activeWebContents = webContents
      conversationLog.push(`User: ${text}`)
      const historyBlock = formatProcessedHistory(processedHistory)
      const content = historyBlock ? `${historyBlock}\n\n${text}` : text
      queue?.push({ type: 'user', message: { role: 'user', content } })
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
  conversationLog = []
  sessionInit = null
  await sessionStore.clear()
}

export async function getSettings(): Promise<AgentSettings> {
  await ensureSettingsLoaded()
  return currentSettings
}

export async function setSettings(next: AgentSettings): Promise<AgentSettings> {
  await settingsStore.save(next)
  const reloaded = await settingsStore.load()
  currentSettings = reloaded
  settingsLoaded = Promise.resolve()
  await resetSession()
  return reloaded
}

export async function shutdown(): Promise<void> {
  await resetSession()
}
