import { query } from '@anthropic-ai/claude-agent-sdk'
import {
  response,
  errorResponse,
  notification,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
  BUSY,
  NOT_INITIALIZED,
  NO_TOKEN,
} from './jsonrpc.mjs'

const SIDECAR_VERSION = '0.1.0'

export class Server {
  // mode: 'chat' (multiplexed) | 'title' (single-flight)
  // emit: function(messageObject) — sends a message back over the wire
  constructor({ mode, emit }) {
    if (mode !== 'chat' && mode !== 'title') {
      throw new Error(`invalid mode: ${mode}`)
    }
    this.mode = mode
    this.emit = emit
    this.initialized = false
    this.token = null
    // runId -> AbortController
    this.activeChats = new Map()
    this.shuttingDown = false
  }

  async handle(message) {
    if (message?.__parseError) {
      this.emit(errorResponse(null, -32700, 'Parse error'))
      return
    }
    if (message?.jsonrpc !== '2.0') {
      this.emit(errorResponse(message?.id ?? null, INVALID_REQUEST, 'Invalid Request'))
      return
    }

    const { method, params, id } = message
    const isRequest = id !== undefined

    try {
      switch (method) {
        case 'initialize':
          return this.#handleInitialize(id, params)
        case 'setToken':
          return this.#handleSetToken(id, params)
        case 'chat':
          return this.#handleChat(id, params)
        case 'chat/cancel':
          return this.#handleCancel(params)
        case 'shutdown':
          return this.#handleShutdown(id)
        default:
          if (isRequest) {
            this.emit(errorResponse(id, METHOD_NOT_FOUND, `Method not found: ${method}`))
          }
          return
      }
    } catch (err) {
      if (isRequest) {
        this.emit(errorResponse(id, INTERNAL_ERROR, err?.message ?? String(err)))
      }
    }
  }

  #handleInitialize(id, params) {
    if (id === undefined) return
    this.initialized = true
    this.emit(
      response(id, {
        sidecarVersion: SIDECAR_VERSION,
        node: process.version,
        mode: this.mode,
      }),
    )
  }

  #handleSetToken(id, params) {
    if (id === undefined) return
    if (!this.initialized) {
      this.emit(errorResponse(id, NOT_INITIALIZED, 'initialize required first'))
      return
    }
    const token = params?.token
    if (typeof token !== 'string' || !token.startsWith('sk-ant-oat')) {
      this.emit(errorResponse(id, INVALID_PARAMS, 'token must be sk-ant-oat...'))
      return
    }
    this.token = token
    this.emit(response(id, null))
  }

  #handleChat(id, params) {
    if (id === undefined) return
    if (!this.initialized) {
      this.emit(errorResponse(id, NOT_INITIALIZED, 'initialize required first'))
      return
    }
    if (!this.token) {
      this.emit(errorResponse(id, NO_TOKEN, 'setToken required before chat'))
      return
    }

    const runId = params?.runId
    if (typeof runId !== 'string' || !runId) {
      this.emit(errorResponse(id, INVALID_PARAMS, 'runId required'))
      return
    }
    if (this.activeChats.has(runId)) {
      this.emit(errorResponse(id, INVALID_PARAMS, `runId already active: ${runId}`))
      return
    }
    if (this.mode === 'title' && this.activeChats.size > 0) {
      this.emit(errorResponse(id, BUSY, 'title sidecar is single-flight'))
      return
    }
    if (this.shuttingDown) {
      this.emit(errorResponse(id, INVALID_REQUEST, 'shutting down'))
      return
    }

    // Inject the freshest token into the env every chat. The SDK reads this
    // exact env var; we strip competing creds to avoid surprises.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = this.token
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN

    const controller = new AbortController()
    this.activeChats.set(runId, controller)

    // Acknowledge acceptance before we start streaming.
    this.emit(response(id, { runId, accepted: true }))

    this.#runChat(runId, params, controller).catch((err) => {
      this.#emitChatError(runId, 'INTERNAL', err?.message ?? String(err), true)
      this.activeChats.delete(runId)
    })
  }

  async #runChat(runId, params, controller) {
    const {
      prompt,
      model,
      systemPrompt,
      tools,
      permissionMode = 'bypassPermissions',
    } = params

    const options = {
      permissionMode,
      abortController: controller,
    }
    if (model) options.model = model
    if (systemPrompt) options.systemPrompt = systemPrompt
    if (Array.isArray(tools) && tools.length > 0) {
      // The SDK takes tool definitions via the `tools` option on query().
      // Pass through whatever the caller provides; we don't validate shape here.
      options.tools = tools
    }

    let lastResult = null
    try {
      const stream = query({ prompt, options })
      for await (const event of stream) {
        if (controller.signal.aborted) break
        this.emit(notification('chat/event', { runId, event }))
        if (event?.type === 'result') {
          lastResult = event
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        this.#emitChatError(runId, 'CANCELLED', 'cancelled by client', false)
      } else {
        const code = classifyError(err)
        this.#emitChatError(runId, code, err?.message ?? String(err), code !== 'AUTH')
      }
      this.activeChats.delete(runId)
      return
    }

    if (controller.signal.aborted) {
      this.#emitChatError(runId, 'CANCELLED', 'cancelled by client', false)
    } else {
      this.emit(
        notification('chat/done', {
          runId,
          stopReason: lastResult?.stop_reason ?? null,
          usage: lastResult?.usage ?? null,
          totalCostUsd: lastResult?.total_cost_usd ?? null,
        }),
      )
    }
    this.activeChats.delete(runId)
  }

  #emitChatError(runId, code, message, retryable) {
    this.emit(notification('chat/error', { runId, code, message, retryable }))
  }

  #handleCancel(params) {
    const runId = params?.runId
    if (typeof runId !== 'string') return
    const controller = this.activeChats.get(runId)
    if (!controller) return
    controller.abort()
    // The runChat loop will emit CANCELLED and clear the entry.
  }

  async #handleShutdown(id) {
    this.shuttingDown = true
    for (const [, controller] of this.activeChats) controller.abort()
    if (id !== undefined) this.emit(response(id, null))
    // Give in-flight chats a moment to flush their CANCELLED notifications.
    setTimeout(() => process.exit(0), 250)
  }
}

function classifyError(err) {
  const msg = err?.message ? String(err.message) : String(err)
  if (/401|unauthor|invalid[_ ]?token/i.test(msg)) return 'AUTH'
  if (/429|rate[_ ]?limit/i.test(msg)) return 'RATE_LIMIT'
  if (/network|fetch failed|ECONN|ETIMEDOUT/i.test(msg)) return 'NETWORK'
  return 'INTERNAL'
}
