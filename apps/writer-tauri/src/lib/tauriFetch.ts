// fetch() shim that routes Anthropic API calls through the Tauri Rust
// backend. The JS Anthropic SDK accepts a custom fetch via constructor
// option, so giving it this function lets us:
//
//   - bypass CORS (browser webviews can't hit api.anthropic.com directly)
//   - keep the OAuth token in Rust keychain (never leaks to JS)
//   - reuse the SDK's SSE parsing, retries, types, tool helpers
//
// Wire protocol (matches src-tauri/src/claude_api.rs):
//   invoke('claude_proxy', { request: { channelId, url, method, headers, body } })
//   then listen for:
//     claude_proxy:status:<id>  → { status, headers }       (once)
//     claude_proxy:chunk:<id>   → number[] (raw bytes)      (many)
//     claude_proxy:done:<id>    → ()                        (terminal)
//     claude_proxy:error:<id>   → { message }               (terminal)
//   to cancel: invoke('claude_cancel', { channelId })

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

interface StatusPayload {
  status: number
  headers: Record<string, string>
}

interface ErrorPayload {
  message: string
}

export const tauriFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const method = (init?.method ?? 'GET').toUpperCase()
  const headers = headersToRecord(init?.headers, input)
  const body = init?.body == null ? undefined : await bodyToString(init.body)

  const channelId = crypto.randomUUID()
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)

  // Resolve once we get the status event so we can return a Response.
  let statusResolve: (s: StatusPayload) => void = () => {}
  let statusReject: (e: Error) => void = () => {}
  const statusPromise = new Promise<StatusPayload>((res, rej) => {
    statusResolve = res
    statusReject = rej
  })

  // Body stream — chunks queued by event handlers, drained by the SDK.
  let bodyController!: ReadableStreamDefaultController<Uint8Array>
  const bodyStream = new ReadableStream<Uint8Array>({
    start(c) {
      bodyController = c
    },
    cancel() {
      void invoke('claude_cancel', { channelId }).catch(() => {})
    },
  })

  const unlisteners: UnlistenFn[] = []
  let settled = false

  const cleanup = () => {
    if (settled) return
    settled = true
    for (const u of unlisteners) u()
  }

  const fail = (msg: string) => {
    if (settled) return
    statusReject(new Error(msg))
    try {
      bodyController.error(new Error(msg))
    } catch {
      // controller may already be closed
    }
    cleanup()
  }

  unlisteners.push(
    await listen<StatusPayload>(`claude_proxy:status:${channelId}`, (e) => {
      statusResolve(e.payload)
    }),
  )
  unlisteners.push(
    await listen<number[]>(`claude_proxy:chunk:${channelId}`, (e) => {
      try {
        bodyController.enqueue(new Uint8Array(e.payload))
      } catch {
        // stream closed/cancelled
      }
    }),
  )
  unlisteners.push(
    await listen<null>(`claude_proxy:done:${channelId}`, () => {
      try {
        bodyController.close()
      } catch {
        // already closed
      }
      cleanup()
    }),
  )
  unlisteners.push(
    await listen<ErrorPayload>(`claude_proxy:error:${channelId}`, (e) => {
      fail(e.payload?.message ?? 'proxy error')
    }),
  )

  if (signal) {
    if (signal.aborted) {
      fail('aborted')
      void invoke('claude_cancel', { channelId }).catch(() => {})
      throw new DOMException('aborted', 'AbortError')
    }
    signal.addEventListener('abort', () => {
      fail('aborted')
      void invoke('claude_cancel', { channelId }).catch(() => {})
    })
  }

  // Kick off the request. Errors before status arrives propagate via the
  // error event, so we don't await this — we await the status event.
  invoke('claude_proxy', {
    request: { channelId, url, method, headers, body },
  }).catch((e) => fail(typeof e === 'string' ? e : `proxy invoke failed: ${e}`))

  const status = await statusPromise

  return new Response(bodyStream, {
    status: status.status,
    headers: new Headers(status.headers),
  })
}

function headersToRecord(
  h: HeadersInit | undefined,
  input: RequestInfo | URL,
): Record<string, string> {
  const out: Record<string, string> = {}
  // Headers from a Request object
  if (input instanceof Request) {
    input.headers.forEach((v, k) => {
      out[k] = v
    })
  }
  if (!h) return out
  if (h instanceof Headers) {
    h.forEach((v, k) => {
      out[k] = v
    })
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[k] = v
  } else {
    Object.assign(out, h)
  }
  return out
}

async function bodyToString(body: BodyInit): Promise<string> {
  if (typeof body === 'string') return body
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body)
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(body as Uint8Array)
  }
  if (body instanceof Blob) return await body.text()
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof ReadableStream) {
    // Anthropic SDK doesn't stream request bodies, but cover it for safety.
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0)
    const merged = new Uint8Array(total)
    let off = 0
    for (const c of chunks) {
      merged.set(c, off)
      off += c.byteLength
    }
    return new TextDecoder().decode(merged)
  }
  return String(body)
}
