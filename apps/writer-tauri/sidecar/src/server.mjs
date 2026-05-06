import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
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

// Relay tools: defined here, but every invocation reports back to the host
// (frontend) via a notification rather than performing the action itself.
// The frontend (which owns the editor / UI) does the real work.

function buildProposeChangeTool(runId, emit) {
  return tool(
    'propose_change',
    'Propose a single suggestion or comment for the current document. Call this once per issue you find.',
    {
      kind: z.enum(['suggestion', 'comment']),
      suggestionType: z.enum(['insert', 'delete', 'replace']).optional(),
      quote: z.string(),
      content: z.string().optional(),
      text: z.string().optional(),
      rationale: z.string().optional(),
    },
    async (args) => {
      emit(notification('chat/proposal', { runId, input: args }))
      return { content: [{ type: 'text', text: 'Proposal recorded.' }] }
    },
  )
}

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
    // Pending waiters for the next setToken call. Resolved when a new token
    // is pushed; used by the AUTH-retry path to coordinate refreshes.
    this.tokenUpdateWaiters = []
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
    const previousToken = this.token
    this.token = token
    this.emit(response(id, null))
    // Wake up anyone waiting for a token rotation (AUTH-retry path).
    if (token !== previousToken && this.tokenUpdateWaiters.length > 0) {
      const waiters = this.tokenUpdateWaiters
      this.tokenUpdateWaiters = []
      for (const w of waiters) w()
    }
  }

  // Returns a Promise that resolves when setToken is called with a new
  // value, or rejects on timeout. Used to coordinate retries after AUTH.
  #waitForTokenUpdate(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.tokenUpdateWaiters = this.tokenUpdateWaiters.filter((w) => w !== fire)
        reject(new Error('timeout waiting for token refresh'))
      }, timeoutMs)
      const fire = () => {
        clearTimeout(timer)
        resolve()
      }
      this.tokenUpdateWaiters.push(fire)
    })
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

    // Token env is injected per-attempt inside #runChat so the AUTH-retry
    // path picks up rotated tokens automatically.

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
      relayTools,
      permissionMode = 'bypassPermissions',
      effort,
      sessionId,
      resume,
    } = params

    const options = {
      permissionMode,
      abortController: controller,
      // Emit `stream_event` notifications token-by-token instead of one
      // SDKAssistantMessage per turn. The frontend reassembles the live
      // text from content_block_delta events.
      includePartialMessages: true,
      // Auto-summarize older turns once context approaches the model
      // limit, instead of erroring out. autoCompactEnabled lives in
      // Settings (sdk.d.ts:5073) — surfaced via the `settings` flag
      // layer, which has higher precedence than user settings.json.
      // The cacheable system-prompt prefix (belief + role) is preserved
      // across compaction; only mid-conversation turns get summarized.
      settings: { autoCompactEnabled: true },
    }
    if (model) options.model = model
    if (systemPrompt) options.systemPrompt = systemPrompt
    // First-class SDK option since claude-agent-sdk@0.2.x. Accepts
    // 'low' | 'medium' | 'high' | 'xhigh' | 'max'. We forward whatever
    // the host sent without revalidating — the SDK clamps unsupported
    // levels per model.
    if (effort) options.effort = effort
    // Session lifecycle: at most one of sessionId/resume per run.
    // Frontend picks based on whether the thread has any prior assistant
    // turn. SDK persists sessions to ~/.claude/projects/ by default so
    // resume works across app restarts.
    if (sessionId) options.sessionId = sessionId
    if (resume) options.resume = resume
    // Dev only: host points us at the .pnpm-store copy of the platform-specific
    // claude binary. Prod ships the binary inside our own node_modules, so the
    // SDK auto-resolves and the env var is intentionally unset.
    if (process.env.CLAUDE_CODE_CLI_PATH) {
      options.pathToClaudeCodeExecutable = process.env.CLAUDE_CODE_CLI_PATH
    }

    // Wire relay tools: each one runs inside this sidecar but its handler
    // just forwards args to the host as a `chat/proposal`-shaped event and
    // returns a brief ack so the model can continue. The actual editor /
    // UI work happens in the frontend.
    const enabledRelay = Array.isArray(relayTools)
      ? relayTools
      : (this.mode === 'chat' ? ['propose_change'] : [])
    const relayDefs = []
    for (const name of enabledRelay) {
      if (name === 'propose_change') {
        relayDefs.push(buildProposeChangeTool(runId, this.emit))
      }
    }
    if (relayDefs.length > 0) {
      const server = createSdkMcpServer({ name: 'writer-relay', tools: relayDefs })
      options.mcpServers = { 'writer-relay': server }
    }

    // Up to two attempts: if the first fails with AUTH, ask the host for a
    // fresh token and retry once. Any other error (or a second AUTH) ends
    // the chat.
    let lastResult = null
    for (let attempt = 1; attempt <= 2; attempt++) {
      // Hand the token to the SDK via options.env so we don't mutate the
      // sidecar's own process.env (which other concurrent chats share).
      // Rebuilding per-attempt picks up rotation between attempt 1 and 2.
      options.env = {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: this.token,
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
      }

      let streamError = null
      lastResult = null
      // Inactivity watchdog. The Claude Agent SDK delegates the actual HTTPS
      // request to a `claude` CLI subprocess; if the network drops mid-stream
      // (Wi-Fi off, ISP hang) the subprocess sits waiting on TCP, no events
      // arrive, and `for await` blocks forever. We watch wall-clock gap
      // between events and abort if it exceeds IDLE_MS — that kills the
      // subprocess and surfaces the failure through the normal error path.
      // 45s is comfortably above realistic reasoning pauses but well below
      // the OS-level TCP keepalive window.
      const IDLE_MS = 45_000
      let idleTimedOut = false
      let lastEventAt = Date.now()
      const watchdog = setInterval(() => {
        if (controller.signal.aborted) return
        if (Date.now() - lastEventAt > IDLE_MS) {
          idleTimedOut = true
          controller.abort()
        }
      }, 5_000)
      try {
        const stream = query({ prompt, options })
        for await (const event of stream) {
          if (controller.signal.aborted) break
          lastEventAt = Date.now()
          this.emit(notification('chat/event', { runId, event }))
          if (event?.type === 'result') {
            lastResult = event
          }
        }
      } catch (err) {
        streamError = err
      } finally {
        clearInterval(watchdog)
      }

      if (controller.signal.aborted) {
        if (idleTimedOut) {
          this.#emitChatError(
            runId,
            'IDLE_TIMEOUT',
            `No response for ${Math.round(IDLE_MS / 1000)}s — check your network connection`,
            true,
          )
        } else {
          this.#emitChatError(runId, 'CANCELLED', 'cancelled by client', false)
        }
        this.activeChats.delete(runId)
        return
      }

      if (streamError) {
        const code = classifyError(streamError)
        if (code === 'AUTH' && attempt === 1) {
          // Pause: ask the host to push a fresh token and retry once.
          this.emit(notification('auth/refreshNeeded', { runId }))
          try {
            await this.#waitForTokenUpdate(5000)
            continue // attempt 2 with the rotated token
          } catch {
            // No fresh token in time; fall through to error.
          }
        }
        this.#emitChatError(
          runId,
          code,
          streamError?.message ?? String(streamError),
          code !== 'AUTH',
        )
        this.activeChats.delete(runId)
        return
      }

      // Success
      break
    }

    this.emit(
      notification('chat/done', {
        runId,
        stopReason: lastResult?.stop_reason ?? null,
        usage: lastResult?.usage ?? null,
        totalCostUsd: lastResult?.total_cost_usd ?? null,
      }),
    )
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
  if (/ETIMEDOUT|timed[_ ]?out/i.test(msg)) return 'IDLE_TIMEOUT'
  if (/network|fetch failed|ECONN/i.test(msg)) return 'NETWORK'
  return 'INTERNAL'
}
