import { readFile, readdir } from 'node:fs/promises'
import { join, normalize, relative, isAbsolute, resolve as resolvePath } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { query, tool, createSdkMcpServer, getSessionInfo } from '@anthropic-ai/claude-agent-sdk'
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
import {
  rateLimitPayload,
  mapSdkError,
  classifyError,
  NON_RETRYABLE_CODES,
} from './errors.mjs'
import {
  secretDenyRules,
  egressDenyRules,
  envDumpDenyRules,
  sandboxLockdown,
} from './policy/security.mjs'
import {
  buildProposeEditTool,
  buildProposeWriteTool,
  buildProposeSkillTool,
  buildProposeMultiEditTool,
  buildMoveNoteTool,
  buildEditVisualizationTool,
  extractPendingId,
} from './tools/relay.mjs'


/** True if the SDK has a resumable session persisted under this id. Asks the SDK
 * directly via `getSessionInfo(sessionId)` — the canonical API — instead of
 * reproducing its on-disk layout (`~/.claude/projects/<cwd-encoded>/<id>.jsonl`,
 * whose <cwd-encoded> segment mangles the path); with `dir` omitted the SDK
 * searches every project directory, matching the old scan's coverage but with
 * no coupling to the storage format.
 *
 * Used by the AUTH-retry path to decide resume-vs-recreate: we only `resume` a
 * session that actually exists, so a first attempt that 401'd before anything
 * was written falls back to a clean create instead of erroring on a missing
 * session. `getSessionInfo` returns undefined for a missing OR empty session;
 * its `summary` falls back to the first user prompt, so any session that got a
 * real user turn qualifies — i.e. this matches the old "file exists" check for
 * every session with content, and treats a contentless session (nothing to
 * resume) as not-persisted, which is strictly more correct. Best-effort: any
 * error reads as "not persisted". */
async function sessionPersisted(sessionId) {
  if (!sessionId) return false
  try {
    return (await getSessionInfo(sessionId)) !== undefined
  } catch {
    return false
  }
}

const SIDECAR_VERSION = '0.1.0'

// Wire-protocol contract version. Bump this (in lockstep with the Rust
// `PROTOCOL_VERSION` in claude_sidecar/client.rs) on any breaking change to
// the request/notification shapes in PROTOCOL.md. The host asserts equality
// during `initialize` and refuses to run a mismatched sidecar — this turns
// the "forgot to run `pnpm pack:sidecar`" foot-gun into a loud, immediate
// failure instead of a silently stale sidecar.
const PROTOCOL_VERSION = 1

// Plan-mode workflow body. Replaces the SDK's default code-implementation
// plan steps (the CLI still wraps this with its read-only preamble + the
// ExitPlanMode footer). This is a prose/wiki vault, not a codebase, so we
// steer the model away from diff-style output — a plan rendered as a
// ```diff block looks like a pile of edits in the chat, which it isn't.
const PLAN_MODE_INSTRUCTIONS = [
  'When the plan is ready, call ExitPlanMode and put the COMPLETE plan in its',
  '`plan` argument as markdown — that single plan is what the user reviews and',
  'approves. Do NOT also write the plan as your normal response; keep any chat',
  'text to a sentence at most.',
  '',
  "Write the plan in the user's language (Korean when the conversation is Korean).",
  'This is a writing / wiki vault, not code: concise prose and bullets saying which',
  'page(s) you will change, what the change is, and why. No ```diff or code blocks,',
  'and do not paste the full file content.',
].join('\n')

// Allow-prefix for the plan-mode Write gate: in plan mode the built-in Write is
// permitted only for paths under this dir, so the vault stays read-only while
// planning. (It is NOT the SDK's plansDirectory — that's a `Settings` member we
// don't set; the plan reaches the host via ExitPlanMode.input.plan, driven by
// PLAN_MODE_INSTRUCTIONS, not a file on disk.)
const PLAN_MODE_PLANS_DIR = join(tmpdir(), 'writer-tauri-plans')

/** True only if `filePath` resolves to a location genuinely inside the plans
 * dir. Mirrors `resolveVaultFile`'s idiom: normalise first (collapsing `..`),
 * then boundary-check via `relative`. A raw `startsWith(PLAN_MODE_PLANS_DIR)`
 * is traversal-vulnerable — `<plansdir>/../../.zshrc` passes the prefix but
 * escapes the dir — which would let plan mode (nominally read-only) write
 * outside the vault. */
function isInsidePlansDir(filePath) {
  const raw = String(filePath ?? '').trim()
  if (!raw) return false
  const rel = relative(PLAN_MODE_PLANS_DIR, resolvePath(raw))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Dump a thrown error's full context to stderr so the Rust supervisor's
 * stderr drain (and the dev console downstream) can see what actually
 * happened. The user-facing chat/error notification stays terse — this
 * is purely a debug aid. Captures stack, cause chain, and any custom
 * fields the SDK attaches (rateLimit, code, etc.) without forcing the
 * caller to know which fields exist. */
function logErrorContext(label, runId, err, extras = {}) {
  const lines = [`[sidecar ${label}] runId=${runId}`]
  for (const [k, v] of Object.entries(extras)) {
    if (v !== undefined && v !== null) lines.push(`  ${k}=${v}`)
  }
  if (err && typeof err === 'object') {
    if (err.message) lines.push(`  message=${err.message}`)
    if (err.code) lines.push(`  code=${err.code}`)
    if (err.cause) {
      const c = err.cause
      const causeMsg = c?.message ?? String(c)
      lines.push(`  cause=${causeMsg}`)
      if (c?.stack) lines.push(`  cause.stack=${c.stack}`)
    }
    if (err.stack) lines.push(`  stack=${err.stack}`)
  } else {
    lines.push(`  raw=${String(err)}`)
  }
  process.stderr.write(lines.join('\n') + '\n')
}

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
    // runId -> AbortController-bearing run record. In `chat` mode this backs
    // the legacy turn-scoped path (one query() per turn); it is ALSO the sole
    // registry for `title` mode (single-flight, short-lived — never uses the
    // persistent path). See #handleChat's branch.
    this.activeChats = new Map()
    // threadId -> ThreadRec. The persistent-query path (chat mode, when the
    // host opts in via params.persistentQuery): one long-lived streaming-input
    // query() per conversation thread, driven by a message queue, so a `result`
    // is a TURN boundary rather than a session teardown and background
    // subagent tasks survive across turns. Empty until the first persistent
    // chat lands; the legacy path never touches it.
    this.activeThreads = new Map()
    // runId -> threadId, so the runId-keyed RPCs (chat/cancel) can find the
    // owning thread on the persistent path. Written when a turn is dispatched,
    // deleted when it settles.
    this.runToThread = new Map()
    // decisionId -> { resolve, reject } for in-flight canUseTool gates
    // (plan approval / clarifying questions) awaiting a host decision.
    this.pendingDecisions = new Map()
    // pendingId -> resolve(ok: boolean) for a propose_edit/write/multi_edit
    // proposal awaiting the host's confirmation that it was actually queued
    // into pendingChangesStore. Registered when the tool emits `chat/edit-
    // pending`; resolved by `chat/edit-ack`. Read by the PostToolUse hook
    // (see #buildPostToolUseHooks) — NOT by the tool handlers themselves,
    // which still return immediately (the agent loop's progress on OTHER
    // files/tool-calls isn't blocked on this — only the SINGLE tool result
    // that hook rewrites, if the host reports it didn't land).
    this.pendingAcks = new Map()
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
        case 'models':
          return this.#handleModels(id)
        case 'chat':
          return this.#handleChat(id, params)
        case 'chat/cancel':
          return this.#handleCancel(params)
        case 'chat/close-thread':
          return this.#handleCloseThread(params)
        case 'chat/stop-task':
          return this.#handleStopTask(params)
        case 'chat/decision':
          return this.#handleDecision(params)
        case 'chat/edit-ack':
          return this.#handleEditAck(params)
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
        protocolVersion: PROTOCOL_VERSION,
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

  // List the models this account can actually use, so the host's picker can
  // hide ones the user has no access to (e.g. region-gated models). The list
  // comes from the SDK's session-init handshake via query.supportedModels();
  // each entry carries capability flags (effort levels, fast mode) the host
  // can drive the UI from. Best-effort and bounded: any failure returns an
  // error the host swallows, falling back to its built-in model list.
  async #handleModels(id) {
    if (id === undefined) return
    if (!this.initialized) {
      this.emit(errorResponse(id, NOT_INITIALIZED, 'initialize required first'))
      return
    }
    if (!this.token) {
      this.emit(errorResponse(id, INVALID_PARAMS, 'setToken required first'))
      return
    }
    const controller = new AbortController()
    let releaseInput
    const inputClosed = new Promise((resolve) => {
      releaseInput = resolve
    })
    // No user message — supportedModels() is answered from the init handshake
    // that runs as soon as the claude subprocess starts. The generator just
    // holds the control channel open until we've read the list.
    const makeInput = async function* () {
      await inputClosed
    }
    const options = {
      abortController: controller,
      settingSources: [],
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: this.token,
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
      },
    }
    if (process.env.CLAUDE_CODE_CLI_PATH) {
      options.pathToClaudeCodeExecutable = process.env.CLAUDE_CODE_CLI_PATH
    }
    let stream = null
    try {
      stream = query({ prompt: makeInput(), options })
      // Bound the wait so a wedged subprocess can't hang the request forever.
      const models = await Promise.race([
        stream.supportedModels(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('supportedModels timed out')), 15_000),
        ),
      ])
      this.emit(response(id, { models }))
    } catch (err) {
      logErrorContext('supportedModels', null, err, { mode: this.mode })
      this.emit(errorResponse(id, INTERNAL_ERROR, err?.message ?? String(err)))
    } finally {
      releaseInput() // close input → query tears down
      controller.abort()
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

    // Persistent-query path: opt-in per chat (the host forwards a Settings
    // toggle, exactly like sandboxEnabled). Chat mode only — `title` stays
    // single-flight and short-lived, so it never wants a long-lived query.
    // When on, one streaming-input query() is kept alive per conversation
    // thread and `result` is a turn boundary, so background subagent tasks
    // survive across turns. When off (default), the legacy per-turn path runs
    // unchanged, so flipping the flag is the only behaviour switch.
    if (this.#usePersistentQuery(params)) {
      return this.#handleChatPersistent(id, params)
    }

    // Token env is injected per-attempt inside #runChat so the AUTH-retry
    // path picks up rotated tokens automatically.
    this.#startLegacyRun(runId, params)

    // Acknowledge acceptance before we start streaming.
    this.emit(response(id, { runId, accepted: true }))
  }

  // Whether this chat should use the persistent per-thread query path.
  #usePersistentQuery(params) {
    return this.mode === 'chat' && params?.persistentQuery === true
  }

  // Legacy per-turn run: one AbortController + one query() that tears down at
  // the first `result`. Used when the persistent flag is off (and for title
  // mode, which never uses the persistent path).
  #startLegacyRun(runId, params) {
    // Rollback safety: if the persistent flag was just turned OFF mid-conversation,
    // this legacy turn will `resume` the threadId's SDK session in a NEW query —
    // but the thread's persistent query may still be live in `activeThreads`
    // (the reaper holds it up to IDLE_TTL). Two subprocesses resuming the same
    // session UUID concurrently races on the session file. Pre-emptively tear the
    // persistent thread down (session persists to disk, so nothing is lost) so the
    // legacy resume owns the session cleanly. Makes ON↔OFF toggling safe.
    const threadId = params?.threadId
    if (typeof threadId === 'string' && threadId) {
      const stale = this.activeThreads.get(threadId)
      if (stale) this.#teardownThread(stale, 'flag_rollback')
    }

    const controller = new AbortController()
    // Run record: the AbortController plus, filled in once #runChat starts,
    // the live query handle (for graceful interrupt()), a predicate for
    // whether the model is parked on a user decision, and a cancel-intent
    // flag so a graceful interrupt still settles as CANCELLED.
    this.activeChats.set(runId, {
      controller,
      stream: null,
      isAwaiting: () => false,
      cancelRequested: false,
    })

    this.#runChat(runId, params, controller).catch((err) => {
      logErrorContext('runChat-uncaught', runId, err, { mode: this.mode })
      this.#emitChatError(runId, 'INTERNAL', err?.message ?? String(err), true)
      this.activeChats.delete(runId)
    })
  }

  // Persistent per-thread chat entry. Either creates the thread's long-lived
  // query() (first turn) or pushes this turn's message into the live one. The
  // per-turn runId is a correlation id inside the thread; threadId identifies
  // the conversation (and its SDK session).
  #handleChatPersistent(id, params) {
    const runId = params.runId
    const threadId = params.threadId ?? params.sessionId ?? params.resume
    if (typeof threadId !== 'string' || !threadId) {
      this.emit(errorResponse(id, INVALID_PARAMS, 'threadId (or sessionId/resume) required'))
      return
    }
    // runId must be unique sidecar-wide so runToThread and the frontend's runId
    // demux stay unambiguous.
    if (this.runToThread.has(runId)) {
      this.emit(errorResponse(id, INVALID_PARAMS, `runId already active: ${runId}`))
      return
    }
    const item = { runId, prompt: params.prompt, params }
    this.runToThread.set(runId, threadId)

    const existing = this.activeThreads.get(threadId)
    if (existing && !existing.dead) {
      // A turn that changes model / permissionMode / fastMode reconciles the
      // live query via control requests issued from OUTSIDE the input generator
      // (the canonical placement — a control request awaited from INSIDE the
      // generator that rejects is re-raised by the SDK's streamInput and aborts
      // the whole query), then dispatches the turn. setModel/setPermissionMode
      // don't touch running background tasks, so no background guard is needed;
      // only skip while a turn is mid-flight (settings apply between turns).
      if (this.#turnControlsChanged(existing, params) && !existing.turnActive) {
        this.emit(response(id, { runId, accepted: true, threadId }))
        this.#applyThreadControls(existing, params).then(() => this.#dispatchTurn(existing, item))
        return
      }
      // Reuse the live query — push this turn into its input queue.
      this.#dispatchTurn(existing, item)
      this.emit(response(id, { runId, accepted: true, threadId }))
      return
    }

    // First turn on this thread — build the query, then dispatch into it.
    this.emit(response(id, { runId, accepted: true, threadId }))
    this.#ensureThread(threadId, params)
      .then((rec) => this.#dispatchTurn(rec, item))
      .catch((err) => {
        logErrorContext('ensureThread', runId, err, { mode: this.mode, threadId })
        this.runToThread.delete(runId)
        this.activeThreads.delete(threadId)
        this.#emitChatError(runId, 'INTERNAL', err?.message ?? String(err), true, undefined, threadId)
      })
  }

  // Enqueue a turn into a thread's persistent input generator. Always queue
  // first, then — if the generator is parked waiting for input and no turn is
  // in flight — wake it with the queue head. Queue-then-wake (rather than
  // wake-or-queue) closes the settle→re-park race: an item pushed in the window
  // between a turn settling and the generator re-parking is still picked up,
  // because the generator re-checks the queue on each loop. Strict
  // serialization + FIFO: one turn generates at a time, in arrival order.
  #dispatchTurn(rec, item) {
    // The thread can be torn down between a turn's accept and its dispatch —
    // the #applyThreadControls().then(#dispatchTurn) path awaits control
    // requests, and a shutdown/teardown can land in that gap. Queuing onto a
    // dead thread would strand the turn (its runId is already in runToThread)
    // with no terminal → frontend wedge. Surface a retryable error instead so
    // the frontend re-sends (spinning up a fresh thread).
    if (rec.dead) {
      this.runToThread.delete(item.runId)
      this.#emitChatError(
        item.runId,
        'INTERNAL',
        'thread closed before the turn started',
        true,
        undefined,
        rec.threadId,
      )
      return
    }
    rec.turnQueue.push(item)
    if (rec.nextTurnResolve && !rec.turnActive) {
      const r = rec.nextTurnResolve
      rec.nextTurnResolve = null
      r(rec.turnQueue.shift())
    }
  }

  // Reconcile a turn's model / permissionMode / fastMode with the live query via
  // control requests, issued from OUTSIDE the input generator. This is the
  // canonical placement: setModel/setPermissionMode/applyFlagSettings are
  // top-level Query methods, and a control request awaited from INSIDE the input
  // generator that rejects is re-raised by the SDK's streamInput and aborts the
  // entire query (the "Operation aborted" heisenbug). Each is best-effort
  // (try/catch); optionsSeed is updated so later turns diff against the new
  // baseline. permissionMode also updates rec so the canUseTool gate reads it.
  async #applyThreadControls(rec, params) {
    const mode = params.permissionMode ?? 'bypassPermissions'
    const seedMode = rec.optionsSeed.permissionMode ?? 'bypassPermissions'
    if (mode !== seedMode) {
      try {
        await rec.query.setPermissionMode(mode)
        rec.permissionMode = mode
      } catch (e) {
        logErrorContext('setPermissionMode', rec.currentRunId, e, { mode: this.mode })
      }
    }
    if (params.model && params.model !== rec.optionsSeed.model) {
      try {
        await rec.query.setModel(params.model)
      } catch (e) {
        logErrorContext('setModel', rec.currentRunId, e, { mode: this.mode })
      }
    }
    if (!!params.fastMode !== !!rec.optionsSeed.fastMode) {
      try {
        await rec.query.applyFlagSettings({ fastMode: !!params.fastMode })
      } catch (e) {
        logErrorContext('applyFlagSettings', rec.currentRunId, e, { mode: this.mode })
      }
    }
    rec.optionsSeed = params // new baseline for the next turn's diff
  }

  // Whether a new turn's model / permissionMode / fastMode differs from the
  // thread's current baseline (its optionsSeed). A change is applied to the live
  // query via control requests in #applyThreadControls (setModel /
  // setPermissionMode / applyFlagSettings) — NOT a thread recreate. (Recreate is
  // AUTH-restart only; see #recreateThread.)
  #turnControlsChanged(rec, params) {
    const seed = rec.optionsSeed ?? {}
    const modeOf = (p) => p.permissionMode ?? 'bypassPermissions'
    return (
      (params.model ?? null) !== (seed.model ?? null) ||
      modeOf(params) !== modeOf(seed) ||
      !!params.fastMode !== !!seed.fastMode
    )
  }

  // Recreate a thread from its persisted session with new params, then replay
  // `item`. The state-transfer path (resume) used by the AUTH restart
  // (#restartThreadForAuth) — its only caller — to swap in a fresh token without
  // mutating the live query. (Settings changes do NOT recreate; they go through
  // live control requests — see #applyThreadControls / #turnControlsChanged.)
  // Tears the old thread down first; the identity-
  // guarded #finalizeThreadTeardown keeps the old loop's finally from clobbering
  // the replacement's registry slot.
  async #recreateThread(oldRec, item, newParams, reason) {
    const threadId = oldRec.threadId
    this.#teardownThread(oldRec, reason)
    try {
      const newRec = await this.#ensureThread(threadId, { ...newParams, resume: threadId })
      // The old thread's teardown may have dropped the runId mapping; restore it
      // so cancel can still find the replayed turn.
      this.runToThread.set(item.runId, threadId)
      this.#dispatchTurn(newRec, item)
      return newRec
    } catch (err) {
      logErrorContext('recreateThread', item.runId, err, { mode: this.mode, threadId, reason })
      this.runToThread.delete(item.runId)
      this.#emitChatError(item.runId, 'INTERNAL', err?.message ?? String(err), true, undefined, threadId)
      return null
    }
  }

  // The long-lived input iterable feeding one thread's query(). Yields one user
  // message per turn, then parks until #settleTurn releases it (so turn N's
  // `result` lands before turn N+1 is yielded). Returns — ending the query —
  // only when the thread is closed.
  #threadInput(rec) {
    return (async function* () {
      while (true) {
        const item = await new Promise((resolve) => {
          if (rec.closeRequested) return resolve({ close: true })
          if (rec.turnQueue.length) return resolve(rec.turnQueue.shift())
          rec.nextTurnResolve = resolve
        })
        if (item.close) return

        // Reset per-turn state before this turn generates.
        rec.currentRunId = item.runId
        rec.currentItem = item
        rec.turnController = new AbortController()
        rec.turnActive = true
        rec.cancelRequested = false
        // Guards against a turn emitting two terminals (e.g. a CANCELLED result
        // via #settleTurn AND the interrupt's stream-abort via the loop catch).
        rec.terminalEmitted = false
        rec.awaitingDecision = 0
        rec.planApproved = false
        rec.permissionMode = item.params.permissionMode ?? 'bypassPermissions'
        rec.lastEventAt = Date.now()
        rec.idleTimedOut = false
        rec.lastAssistantError = null
        rec.lastRateLimitInfo = null
        rec.sawRateLimitRetry = false
        rec.rateLimitRejected = false
        // NOTE: model / permissionMode / fastMode are set at build time (turn 1),
        // but a later turn that CHANGES them is handled on THIS live thread — not
        // punted to the legacy path. #handleChatPersistent detects the change
        // (#turnControlsChanged) and reconciles it via live control requests
        // (#applyThreadControls: setModel / setPermissionMode / applyFlagSettings)
        // BEFORE dispatching the changed turn. Those requests are issued from
        // #handleChatPersistent — OUTSIDE this generator — because a control
        // request awaited from INSIDE the generator that rejects is re-raised by
        // the SDK's streamInput and aborts the whole query. plan-mode turns are
        // likewise handled here: canUseTool + planModeInstructions are attached
        // unconditionally in #buildThreadOptions and the gate reads rec live.

        yield {
          type: 'user',
          message: { role: 'user', content: item.prompt },
          parent_tool_use_id: null,
        }

        // Park until this turn's result is fully settled.
        await new Promise((resolve) => {
          rec.turnSettleResolve = resolve
        })
      }
    })()
  }

  // Create a thread's ThreadRec + long-lived query() and start its consumer
  // loop. Options are built ONCE here (systemPrompt / tools / sandbox / relay /
  // hooks / canUseTool); per-turn-mutable state lives on `rec` and is read live
  // by the gate. Session lifecycle: resume when the thread was reaped or the
  // app restarted (session on disk), else create.
  async #ensureThread(threadId, params) {
    // Bound live subprocesses: evict an LRU idle, background-free thread first.
    this.#maybeEvictLRU()
    const controller = new AbortController()
    const rec = {
      threadId,
      controller, // thread-level: abort = hard teardown of the subprocess
      query: null,
      loopDone: null,
      dead: false,
      // input queue (producer/consumer)
      turnQueue: [],
      nextTurnResolve: null,
      closeRequested: false,
      // current turn (reset each turn in #threadInput)
      currentRunId: null,
      // the live turn's dispatch item — kept so an AUTH restart can replay it.
      currentItem: null,
      // one-shot guard so a second AUTH on the same turn gives up (not a loop).
      authRetried: false,
      // synthetic runId for an autonomous background-completion turn (P2) — the
      // model's "task finished" answer that arrives with no active user turn.
      bgTurnRunId: null,
      turnActive: false,
      turnController: null, // per-turn: unparks #requestDecision, never kills the thread
      turnSettleResolve: null,
      cancelRequested: false,
      awaitingDecision: 0,
      planApproved: false,
      permissionMode: params.permissionMode ?? 'bypassPermissions',
      lastEventAt: Date.now(),
      idleTimedOut: false,
      // per-turn error accumulators
      lastAssistantError: null,
      lastRateLimitInfo: null,
      sawRateLimitRetry: false,
      rateLimitRejected: false,
      // background-task tracking (Stage 4)
      backgroundTaskIds: new Set(),
      stopHookBackground: [],
      backgroundRequested: false,
      // reaper (Stage 4)
      lastTurnEndedAt: 0,
      reaperTimer: null,
      optionsSeed: params,
    }
    this.activeThreads.set(threadId, rec)
    const options = await this.#buildThreadOptions(rec)
    rec.query = query({ prompt: this.#threadInput(rec), options })
    // Detached consumer loop; its finally() finalizes teardown.
    rec.loopDone = this.#runThreadLoop(rec)
    return rec
  }

  // Build the query() options for a thread. Mirrors the legacy #runChat option
  // block but reads per-turn-mutable state from `rec` so ONE options object
  // serves every turn. canUseTool + planModeInstructions are attached
  // UNCONDITIONALLY (a later turn may enter plan mode); under bypass the SDK
  // skips the gate, so the common all-bypass thread pays nothing.
  async #buildThreadOptions(rec) {
    const params = rec.optionsSeed
    const {
      model,
      systemPrompt,
      relayTools,
      vaultPath,
      effort,
      fastMode,
      sessionId,
      resume,
      maxTurns,
      builtinTools,
      sandboxEnabled = true,
      allowDelegation = true,
    } = params

    const options = {
      permissionMode: rec.permissionMode,
      // Required companion to `bypassPermissions` (sdk.d.ts: "Must be set to
      // `true` when using permissionMode: 'bypassPermissions'"). Set
      // unconditionally, not gated on the current mode: a persistent thread can
      // switch to/from bypass mid-life via setPermissionMode (plan approval),
      // and this is a host-level opt-in ("this host may use bypass"), not the
      // mode itself — it never FORCES bypass, so it's inert under plan/default.
      // Today's behaviour is unchanged (bypass already works); this closes the
      // forward-compat gap if the SDK starts enforcing the pairing.
      allowDangerouslySkipPermissions: true,
      abortController: rec.controller,
      includePartialMessages: true,
      forwardSubagentText: true,
      agentProgressSummaries: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      settings: {
        autoCompactEnabled: true,
        ...(fastMode ? { fastMode: true } : {}),
        ...(sandboxEnabled
          ? {
              permissions: {
                deny: [...egressDenyRules(), ...envDumpDenyRules(), ...secretDenyRules()],
              },
            }
          : {}),
      },
      settingSources: [],
    }
    if (sandboxEnabled) options.sandbox = sandboxLockdown()
    if (model) options.model = model
    if (systemPrompt) options.systemPrompt = systemPrompt
    if (effort) options.effort = effort
    // Session lifecycle: resume when the thread already has a persisted session
    // (reaped/app-restarted), else create it under threadId.
    if (resume) options.resume = resume
    else if (sessionId) options.sessionId = sessionId
    else if (await sessionPersisted(rec.threadId)) options.resume = rec.threadId
    else options.sessionId = rec.threadId
    if (typeof maxTurns === 'number' && maxTurns > 0) options.maxTurns = maxTurns
    if (process.env.CLAUDE_CODE_CLI_PATH) {
      options.pathToClaudeCodeExecutable = process.env.CLAUDE_CODE_CLI_PATH
    }
    options.env = {
      ...process.env,
      CLAUDE_CODE_OAUTH_TOKEN: this.token,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
    }

    // Gate is always attached (a later turn may switch to plan) and reads rec
    // LIVE. Under bypassPermissions the SDK short-circuits it.
    options.planModeInstructions = PLAN_MODE_INSTRUCTIONS
    options.canUseTool = async (toolName, input) => {
      if (toolName === 'AskUserQuestion') {
        rec.awaitingDecision++
        try {
          const decision = await this.#requestDecision(
            rec.currentRunId,
            toolName,
            input,
            rec.turnController,
          )
          const updatedInput = { questions: input.questions, answers: decision?.answers ?? {} }
          if (decision?.response) updatedInput.response = decision.response
          return { behavior: 'allow', updatedInput }
        } finally {
          rec.awaitingDecision--
        }
      }
      if (rec.permissionMode !== 'plan') {
        return { behavior: 'allow', updatedInput: input }
      }
      // ── Plan-mode read-only enforcement ──
      if (toolName === 'ExitPlanMode') {
        rec.awaitingDecision++
        try {
          const decision = await this.#requestDecision(
            rec.currentRunId,
            toolName,
            input,
            rec.turnController,
          )
          if (decision?.type === 'approve') {
            rec.planApproved = true
            try {
              await rec.query.setPermissionMode('default')
              rec.permissionMode = 'default'
            } catch (e) {
              logErrorContext('setPermissionMode', rec.currentRunId, e, { mode: this.mode })
            }
            return { behavior: 'allow', updatedInput: input }
          }
          return {
            behavior: 'deny',
            message:
              decision?.message || 'The user asked you to revise the plan before proceeding.',
          }
        } finally {
          rec.awaitingDecision--
        }
      }
      if (typeof toolName === 'string' && toolName.includes('propose_')) {
        if (rec.planApproved) return { behavior: 'allow', updatedInput: input }
        return {
          behavior: 'deny',
          message:
            'Plan mode is read-only. Lay out the full plan, then call ExitPlanMode to proceed.',
        }
      }
      if (
        toolName === 'Write' ||
        toolName === 'Edit' ||
        toolName === 'MultiEdit' ||
        toolName === 'NotebookEdit'
      ) {
        const filePath = typeof input?.file_path === 'string' ? input.file_path : ''
        if (isInsidePlansDir(filePath)) return { behavior: 'allow', updatedInput: input }
        return {
          behavior: 'deny',
          message:
            'Plan mode is read-only. Put the plan in ExitPlanMode instead of editing files.',
        }
      }
      return { behavior: 'allow', updatedInput: input }
    }

    // Vault: cwd + built-in toolset + agent plugin (commands/agents/skills).
    let existingSkills = []
    if (vaultPath) {
      options.cwd = vaultPath
      options.tools =
        Array.isArray(builtinTools) && builtinTools.length > 0
          ? builtinTools
          : { type: 'preset', preset: 'claude_code' }
      try {
        const pluginRoot = join(vaultPath, '_system/agent')
        await readdir(pluginRoot)
        options.plugins = [{ type: 'local', path: pluginRoot }]
        if (allowDelegation && Array.isArray(options.tools)) {
          for (const t of ['Skill', 'Task']) {
            if (!options.tools.includes(t)) options.tools = [...options.tools, t]
          }
        }
        try {
          const skillsRoot = join(pluginRoot, 'skills')
          const skillNames = (await readdir(skillsRoot, { withFileTypes: true }))
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
          if (skillNames.length > 0) {
            options.skills = skillNames
            for (const dir of skillNames) {
              try {
                const raw = await readFile(join(skillsRoot, dir, 'SKILL.md'), 'utf-8')
                const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''
                const pick = (k) =>
                  fm
                    .split('\n')
                    .find((l) => l.startsWith(`${k}:`))
                    ?.slice(k.length + 1)
                    .trim()
                    .replace(/^["']|["']$/g, '') ?? ''
                existingSkills.push({ name: pick('name') || dir, description: pick('description') })
              } catch {
                // Unreadable SKILL.md — skip.
              }
            }
          }
        } catch {
          // No skills/ subdir.
        }
      } catch {
        // No plugin dir.
      }
    }

    const enabledRelay = Array.isArray(relayTools) ? relayTools : []
    const relayServer = this.#buildRelayServer(
      enabledRelay,
      () => rec.currentRunId, // live per-turn runId
      vaultPath,
      existingSkills,
    )
    if (relayServer) options.mcpServers = { 'writer-relay': relayServer }

    // PostToolUse: proposal-ack confirmation (shared with legacy). Stop: snapshot
    // the authoritative in-flight background inventory each turn end, so the
    // reaper can tell "thread idle & done" from "idle but awaiting a background
    // wake". Non-blocking (returns {}).
    options.hooks = {
      PostToolUse: this.#postToolUseHooks(),
      Stop: [
        {
          hooks: [
            async (input) => {
              rec.stopHookBackground = Array.isArray(input?.background_tasks)
                ? input.background_tasks
                : []
              return {}
            },
          ],
        },
      ],
    }
    return options
  }

  // The thread's long-lived consumer loop. Unlike the legacy per-turn loop it
  // NEVER breaks on `result` — a result is a turn boundary handled by
  // #settleTurn, and the loop keeps reading so background subagent tasks stream
  // across turns. Exits only when the query ends (thread closed / stream error).
  async #runThreadLoop(rec) {
    const watchdog = setInterval(() => this.#tickThreadWatchdog(rec), 5_000)
    try {
      for await (const event of rec.query) {
        rec.lastEventAt = Date.now()

        // (1) Background task lifecycle → dedicated chat/task channel, tracked
        // for the reaper. Never emitted on the chat/event firehose.
        if (this.#isTaskEvent(event)) {
          this.#trackBackground(rec, event)
          continue
        }

        // (2) Route the event to a runId. During a user turn → rec.currentRunId.
        // Between turns, a content event begins an AUTONOMOUS background-
        // completion turn (P2 — the model's "task finished" answer with no user
        // input); tag it with a synthetic bgTurnRunId + background:true.
        const isBg = !rec.turnActive
        if (isBg && !rec.bgTurnRunId && this.#isContentEvent(event)) {
          rec.bgTurnRunId = globalThis.crypto.randomUUID()
        }
        const runId = rec.turnActive ? rec.currentRunId : rec.bgTurnRunId
        this.emit(
          notification('chat/event', {
            threadId: rec.threadId,
            runId,
            ...(isBg ? { background: true } : {}),
            event,
          }),
        )

        if (event?.type === 'assistant' && event.error) rec.lastAssistantError = event.error
        if (
          event?.type === 'system' &&
          event.subtype === 'api_retry' &&
          event.error === 'rate_limit'
        ) {
          rec.sawRateLimitRetry = true
        }
        if (event?.type === 'rate_limit_event' && event.rate_limit_info) {
          rec.lastRateLimitInfo = event.rate_limit_info
          const info = event.rate_limit_info
          const overageBlocked = info.overageInUse && info.overageStatus === 'rejected'
          if (info.status === 'rejected' || overageBlocked) {
            rec.rateLimitRejected = true
            // Fail-fast on a hard quota rejection: it won't clear within the
            // SDK's retry window (~10 attempts over minutes). Surface RATE_LIMIT
            // now and interrupt the TURN's generation instead of grinding futile
            // retries — mirrors the legacy path's abort+emit, but interrupts the
            // turn only (the thread and any background tasks stay alive). The
            // `terminalEmitted` guard means the interrupt's eventual `result`
            // settles via #settleTurn's early-return, with no double emit.
            if (rec.turnActive && rec.currentRunId && !rec.terminalEmitted) {
              rec.terminalEmitted = true
              this.#emitChatError(
                rec.currentRunId,
                'RATE_LIMIT',
                'rate limited',
                true,
                rateLimitPayload(info),
                rec.threadId,
              )
              Promise.resolve()
                .then(() => rec.query?.interrupt())
                .catch((e) =>
                  logErrorContext('interrupt', rec.currentRunId, e, {
                    mode: this.mode,
                    threadId: rec.threadId,
                  }),
                )
            }
          }
        }
        if (event?.type === 'result') {
          if (rec.turnActive) await this.#settleTurn(rec, event)
          else this.#settleBackgroundTurn(rec, event)
          continue
        }
      }
    } catch (err) {
      // A stream-level error kills the whole thread query. Surface it on the
      // current turn (if one is active); the next chat on this threadId resumes
      // from disk.
      logErrorContext('threadLoop', rec.currentRunId, err, {
        mode: this.mode,
        threadId: rec.threadId,
      })
      if (rec.turnActive && rec.currentRunId && !rec.terminalEmitted) {
        const code = classifyError(err)
        // Mid-thread token expiry thrown at the stream level → recreate + replay
        // (the finally's identity-guarded finalize won't clobber the new thread).
        if (code === 'AUTH' && (await this.#restartThreadForAuth(rec, rec.currentRunId))) {
          rec.turnActive = false
          const r = rec.turnSettleResolve
          rec.turnSettleResolve = null
          if (r) r()
        } else {
          rec.terminalEmitted = true
          // A user cancel interrupts via a stream abort ("aborted by user"); show
          // it as CANCELLED, not a generic INTERNAL error.
          if (rec.cancelRequested) {
            this.#emitChatError(
              rec.currentRunId,
              'CANCELLED',
              'cancelled by client',
              false,
              undefined,
              rec.threadId,
            )
          } else {
            this.#emitChatError(
              rec.currentRunId,
              code,
              err?.message ?? String(err),
              !NON_RETRYABLE_CODES.has(code),
              undefined,
              rec.threadId,
            )
          }
          // Release a parked turn so a caller awaiting settle isn't wedged.
          rec.turnActive = false
          const r = rec.turnSettleResolve
          rec.turnSettleResolve = null
          if (r) r()
        }
      }
    } finally {
      clearInterval(watchdog)
      // Defensive terminal: if the query generator ended while a turn was still
      // active and no terminal was emitted (a `result`-less stream close — e.g.
      // the SDK ends the loop internally on a budget/retry limit — that bypasses
      // both #settleTurn and the catch above), the parked turn would wedge with
      // no chat/done|error for its runId. Emit INTERNAL (retryable) and release
      // the park. Every intentional terminal path sets terminalEmitted, so this
      // only fires on the genuinely-missed case.
      if (rec.turnActive && rec.currentRunId && !rec.terminalEmitted) {
        // Observability: this defensive path firing means a real turn ended with
        // no terminal from the normal paths — worth knowing if it happens.
        logErrorContext('threadLoop-terminalless', rec.currentRunId, new Error('stream ended with active turn, no terminal'), {
          mode: this.mode,
          threadId: rec.threadId,
        })
        rec.terminalEmitted = true
        this.#emitChatError(
          rec.currentRunId,
          'INTERNAL',
          'the model stream ended unexpectedly',
          true,
          undefined,
          rec.threadId,
        )
        rec.turnActive = false
        const r = rec.turnSettleResolve
        rec.turnSettleResolve = null
        if (r) r()
      }
      this.#finalizeThreadTeardown(rec)
    }
  }

  // Turn boundary. A `result` settles the CURRENT turn (emit chat/done or a
  // typed chat/error) but keeps the thread query alive. A result that arrives
  // with no active turn is an autonomous background continuation — #runThreadLoop
  // routes THAT to #settleBackgroundTurn instead of here, so this method only
  // ever runs for a real user turn (guarded below) and never emits a
  // runId-less chat/done.
  async #settleTurn(rec, result) {
    if (!rec.turnActive || !rec.currentRunId) return

    let contextUsage = null
    try {
      contextUsage = await rec.query.getContextUsage()
    } catch (e) {
      logErrorContext('getContextUsage', rec.currentRunId, e, { mode: this.mode })
    }

    const runId = rec.currentRunId
    rec.turnActive = false
    rec.lastTurnEndedAt = Date.now()

    // The interrupt() path can land a clean `result` here AND abort the stream
    // (loop catch). Whichever runs first emits the single terminal; the other
    // skips. Settle still advances the generator/registries below.
    if (rec.terminalEmitted) {
      this.runToThread.delete(runId)
      rec.currentRunId = null
      this.#armReaper(rec)
      const rr = rec.turnSettleResolve
      rec.turnSettleResolve = null
      if (rr) rr()
      return
    }
    rec.terminalEmitted = true

    if (rec.cancelRequested) {
      this.#emitChatError(runId, 'CANCELLED', 'cancelled by client', false, undefined, rec.threadId)
    } else if (result.is_error || String(result.subtype ?? '').startsWith('error_')) {
      let { code, message, retryable } = mapSdkError({
        subtype: result.subtype,
        assistantError: rec.lastAssistantError,
        errors: result.errors,
      })
      if (code !== 'RATE_LIMIT' && (rec.lastRateLimitInfo?.status === 'rejected' || rec.sawRateLimitRetry)) {
        code = 'RATE_LIMIT'
        message = 'rate limited'
        retryable = true
      }
      // Mid-thread token expiry: recreate the thread with a fresh token and
      // replay this turn instead of surfacing AUTH. #restartThreadForAuth reads
      // rec.currentItem, so capture the runId release below only when NOT
      // restarting (the restart re-dispatches under the same runId).
      if (code === 'AUTH') {
        const restarting = await this.#restartThreadForAuth(rec, runId)
        if (restarting) {
          // The old thread was torn down; the replay runs on a fresh thread.
          // Release this generator turn so the old loop unwinds cleanly.
          rec.turnActive = false
          const rr = rec.turnSettleResolve
          rec.turnSettleResolve = null
          if (rr) rr()
          return
        }
      }
      this.#emitChatError(
        runId,
        code,
        message,
        retryable,
        code === 'RATE_LIMIT' ? rateLimitPayload(rec.lastRateLimitInfo) : undefined,
        rec.threadId,
      )
    } else {
      this.emit(
        notification('chat/done', {
          threadId: rec.threadId,
          runId,
          stopReason: result.stop_reason ?? null,
          usage: result.usage ?? null,
          totalCostUsd: result.total_cost_usd ?? null,
          contextUsage,
          fastModeState: result.fast_mode_state ?? null,
          // Turn done, but background work continues — the frontend keeps the
          // thread's background surface live instead of treating it as fully idle.
          backgroundRequested: result.terminal_reason === 'background_requested',
        }),
      )
      if (result.terminal_reason === 'background_requested') rec.backgroundRequested = true
    }

    this.runToThread.delete(runId)
    rec.currentRunId = null
    this.#armReaper(rec) // idle-close countdown (guarded by backgroundInFlight)
    const r = rec.turnSettleResolve
    rec.turnSettleResolve = null
    if (r) r()
  }

  // Settle an AUTONOMOUS background-completion turn (P2): the model generated a
  // "task finished" answer with no active user turn. Emit a chat/done tagged
  // background:true under the synthetic bgTurnRunId so the frontend can render
  // it as a standalone assistant turn (not anchored to any runChat).
  #settleBackgroundTurn(rec, result) {
    const runId = rec.bgTurnRunId
    rec.bgTurnRunId = null
    this.#armReaper(rec)
    if (!runId) return // a result with no preceding content — nothing to settle
    if (result.is_error || String(result.subtype ?? '').startsWith('error_')) {
      const { code, message, retryable } = mapSdkError({
        subtype: result.subtype,
        assistantError: rec.lastAssistantError,
        errors: result.errors,
      })
      this.emit(
        notification('chat/error', {
          runId,
          threadId: rec.threadId,
          code,
          message,
          retryable,
          background: true,
        }),
      )
      return
    }
    this.emit(
      notification('chat/done', {
        threadId: rec.threadId,
        runId,
        background: true,
        stopReason: result.stop_reason ?? null,
        usage: result.usage ?? null,
        totalCostUsd: result.total_cost_usd ?? null,
        contextUsage: null,
        fastModeState: result.fast_mode_state ?? null,
      }),
    )
  }

  // A `type:'system'` task-lifecycle event (or the opaque background_tasks_changed
  // signal). These carry background subagent state, routed to the dedicated
  // chat/task channel rather than the chat/event firehose.
  #isTaskEvent(event) {
    return (
      event?.type === 'system' &&
      (String(event.subtype ?? '').startsWith('task') ||
        event.subtype === 'background_tasks_changed')
    )
  }

  // A content-bearing event (vs SDK housekeeping like system/init or
  // session_state_changed). Between user turns, the FIRST content event marks
  // the start of an autonomous background-completion turn.
  #isContentEvent(event) {
    return (
      event?.type === 'assistant' ||
      event?.type === 'stream_event' ||
      event?.type === 'user'
    )
  }

  // Track a background task's lifecycle and forward it on the dedicated
  // chat/task channel. `backgroundTaskIds` is our own in-flight set; combined
  // with the Stop hook's snapshot it tells the reaper when a thread still has
  // work pending. (Confirmed by probe: a `background:true` agent emits
  // task_started → task_progress → task_notification{status,output_file}; the
  // spawning turn's result is terminal_reason 'completed', NOT
  // 'background_requested' — so we must NOT rely on that flag for keep-alive.)
  #trackBackground(rec, event) {
    const st = event.subtype
    if (st === 'task_started' && event.task_id) {
      rec.backgroundTaskIds.add(event.task_id)
    } else if (st === 'task_notification' && event.task_id) {
      rec.backgroundTaskIds.delete(event.task_id)
    } else if (st === 'task_updated' && event.task_id) {
      const s = event.patch?.status
      if (s === 'completed' || s === 'failed' || s === 'killed') {
        rec.backgroundTaskIds.delete(event.task_id)
      }
    }
    const kind =
      st === 'task_started'
        ? 'started'
        : st === 'task_progress'
          ? 'progress'
          : st === 'task_updated'
            ? 'updated'
            : st === 'task_notification'
              ? 'notification'
              : 'changed'
    this.emit(
      notification('chat/task', {
        threadId: rec.threadId,
        runId: rec.turnActive ? rec.currentRunId : (rec.bgTurnRunId ?? null),
        kind,
        taskId: event.task_id ?? null,
        description: event.description,
        subagentType: event.subagent_type,
        toolUses: event.usage?.tool_uses,
        totalTokens: event.usage?.total_tokens,
        lastTool: event.last_tool_name,
        summary: event.summary,
        status: event.status,
        outputFile: event.output_file || undefined,
        patch: event.patch,
      }),
    )
    this.#armReaper(rec)
  }

  // Arm/replace the idle-close countdown. Re-checks backgroundInFlight AT FIRE
  // time (not arm time) so a task that backgrounds just after arming isn't
  // reaped; when it later settles, #trackBackground re-arms. Never reaps a
  // thread that's mid-turn or has background work.
  #armReaper(rec) {
    if (rec.dead) return
    clearTimeout(rec.reaperTimer)
    rec.reaperTimer = setTimeout(() => {
      // Busy (mid-turn, queued turn, or background work) → don't reap; a later
      // event (turn settle / background settle) re-arms.
      if (rec.dead || this.#threadBusy(rec)) return
      this.#teardownThread(rec, 'idle_reap')
    }, IDLE_TTL_MS)
  }

  // Enforce MAX_LIVE_THREADS by evicting the least-recently-used idle,
  // background-free thread. A thread mid-turn or with background work is never
  // evicted. Evicted threads resume from disk on their next turn.
  #maybeEvictLRU() {
    if (this.activeThreads.size < MAX_LIVE_THREADS) return
    let victim = null
    for (const [, rec] of this.activeThreads) {
      // Never evict a busy thread — mid-turn, a queued-but-not-yet-started turn,
      // or live background work. (Missing the queued-turn case is the turn-loss
      // race — see #threadBusy.)
      if (rec.dead || this.#threadBusy(rec)) continue
      if (!victim || rec.lastTurnEndedAt < victim.lastTurnEndedAt) victim = rec
    }
    if (victim) this.#teardownThread(victim, 'lru_evict')
  }

  // Per-thread idle watchdog. Guards ONLY an in-progress turn: an idle-but-alive
  // thread (awaiting the next user message, or waiting on background work) is
  // never timed out — only the reaper (Stage 4) closes those, and only when
  // background-free. A wedged turn hard-closes the thread; it resumes next turn.
  #tickThreadWatchdog(rec) {
    if (rec.dead || rec.controller.signal.aborted) return
    if (!rec.turnActive) return
    if (rec.awaitingDecision > 0) {
      rec.lastEventAt = Date.now()
      return
    }
    if (Date.now() - rec.lastEventAt > TURN_IDLE_MS) {
      rec.idleTimedOut = true
      // Set the terminal guard BEFORE emitting so the loop's finally (which fires
      // when the torn-down generator returns) doesn't re-emit a second terminal
      // for this runId. Keeps the "every terminal path sets terminalEmitted"
      // invariant that the finally guard relies on.
      rec.terminalEmitted = true
      this.#emitChatError(
        rec.currentRunId,
        'IDLE_TIMEOUT',
        `No response for ${Math.round(TURN_IDLE_MS / 1000)}s — check your network connection`,
        true,
        undefined,
        rec.threadId,
      )
      this.#teardownThread(rec, 'idle_timeout')
    }
  }

  // Graceful thread close: signal the generator to return, release any parked
  // turn, then hard-abort as a backstop. The session persists to disk, so the
  // next chat for this threadId resumes cleanly. Idempotent.
  #teardownThread(rec, reason) {
    if (rec.dead) return
    // Observability: one line per teardown with its reason. The distribution
    // (lru_evict / idle_reap / cancel_wedged / auth_restart / flag_rollback /
    // idle_timeout / closed / shutdown) is the primary early-warning signal for
    // persistent-path regressions once the flag is on — e.g. lru_evict spiking
    // near mid-flight would flag the turn-loss race (A1). Drains via the Rust
    // supervisor's stderr, same channel as logErrorContext.
    process.stderr.write(
      `[sidecar thread-teardown] threadId=${rec.threadId} reason=${reason}` +
        ` turnActive=${rec.turnActive} bg=${this.#backgroundInFlight(rec)}\n`,
    )
    rec.dead = true
    rec.closeRequested = true
    if (rec.nextTurnResolve) {
      const r = rec.nextTurnResolve
      rec.nextTurnResolve = null
      r({ close: true })
    }
    if (rec.turnSettleResolve) {
      const r = rec.turnSettleResolve
      rec.turnSettleResolve = null
      r()
    }
    clearTimeout(rec.reaperTimer)
    try {
      rec.controller.abort()
    } catch {
      // best-effort
    }
  }

  // Remove a thread from the registries once its consumer loop has exited.
  // Guard the delete on identity: an AUTH restart recreates a NEW rec under the
  // same threadId, and the OLD loop's finally must not clobber that replacement.
  #finalizeThreadTeardown(rec) {
    clearTimeout(rec.reaperTimer)
    if (this.activeThreads.get(rec.threadId) === rec) {
      this.activeThreads.delete(rec.threadId)
      // Only drop the runId mapping when we still own the thread slot — during
      // an AUTH restart the replacement thread owns it and needs the mapping.
      if (rec.currentRunId) this.runToThread.delete(rec.currentRunId)
    }
  }

  // Whether a thread still has background subagent work in flight — the signal
  // that keeps the reaper from closing an otherwise-idle thread. Authoritative
  // source is the Stop hook's `background_tasks[]` snapshot; the task-id set and
  // the `background_requested` latch cover the window before/after the hook
  // fires. (Deliberately NOT `query.backgroundTasks()`, which is an ACTION that
  // backgrounds foreground tasks, not a live inventory.)
  #backgroundInFlight(rec) {
    return (
      rec.backgroundTaskIds.size > 0 ||
      rec.stopHookBackground.length > 0 ||
      rec.backgroundRequested
    )
  }

  // Whether a thread is doing (or about to do) work and so must NOT be reaped or
  // LRU-evicted. Three signals: a turn is generating (`turnActive`), a turn is
  // queued but not yet picked up (`turnQueue.length` — the settle→re-park window
  // where `#settleTurn` has set turnActive=false but `#threadInput` hasn't yet
  // shifted the next item), or background subagent work is live. Missing the
  // queued-turn signal is the turn-loss race: an evict in that window tears the
  // thread down and the queued turn vanishes with no terminal for its runId.
  #threadBusy(rec) {
    return rec.turnActive || rec.turnQueue.length > 0 || this.#backgroundInFlight(rec)
  }

  // Build the `writer-relay` MCP server from the enabled relay-tool names, or
  // null when none are enabled. `getRunId` is a getter (not a value) so each
  // relay call stamps the runId that's live at emit time — constant on the
  // legacy single-turn path, `() => rec.currentRunId` on the persistent path
  // where one server instance serves many turns.
  #buildRelayServer(enabledRelay, getRunId, vaultPath, existingSkills) {
    const relayDefs = []
    for (const name of enabledRelay) {
      if (name === 'propose_edit') {
        relayDefs.push(
          buildProposeEditTool(getRunId, this.emit, vaultPath, (id) => this.#registerAckSlot(id)),
        )
      } else if (name === 'propose_write') {
        relayDefs.push(buildProposeWriteTool(getRunId, this.emit, (id) => this.#registerAckSlot(id)))
      } else if (name === 'propose_skill') {
        relayDefs.push(buildProposeSkillTool(getRunId, this.emit, existingSkills))
      } else if (name === 'propose_multi_edit') {
        relayDefs.push(
          buildProposeMultiEditTool(getRunId, this.emit, vaultPath, (id) =>
            this.#registerAckSlot(id),
          ),
        )
      } else if (name === 'move_note') {
        relayDefs.push(buildMoveNoteTool(getRunId, this.emit))
      } else if (name === 'edit_visualization') {
        relayDefs.push(buildEditVisualizationTool(getRunId, this.emit))
      }
    }
    if (relayDefs.length === 0) return null
    return createSdkMcpServer({ name: 'writer-relay', tools: relayDefs })
  }

  // The PostToolUse hook that confirms propose_edit/write/multi_edit proposals
  // actually landed in the host's pendingChangesStore before the model treats
  // them as settled. Keyed by pendingId (runId-independent), so it's shared
  // verbatim by the legacy and persistent paths. See the call site for the
  // full rationale (eager-success gap; fail-open on timeout).
  #postToolUseHooks() {
    return [
      {
        matcher: 'propose_edit|propose_write|propose_multi_edit',
        // Seconds. Local IPC to the host's own process — generous but bounded
        // so a host hang can't stall the agent loop forever.
        timeout: 5,
        hooks: [
          async (input) => {
            const pendingId = extractPendingId(input.tool_response)
            // No id found — this call errored before queuing (e.g.
            // checkOldString rejected it) and already carries its own error
            // text; nothing to confirm.
            if (!pendingId) return {}
            const pending = this.pendingAcks.get(pendingId)
            if (!pending) return {} // no slot registered — let it pass
            // Belt-and-suspenders: race against our OWN timeout too. Fail-open
            // on timeout (ok: true, no rewrite) — don't surface a spurious
            // error over a host that's merely slow, only one that reported
            // failure.
            const { ok, reason } = await Promise.race([
              pending.promise,
              new Promise((r) => setTimeout(() => r({ ok: true, reason: null }), 4000)),
            ])
            this.pendingAcks.delete(pendingId)
            if (ok) return {}
            return {
              hookSpecificOutput: {
                hookEventName: 'PostToolUse',
                updatedToolOutput: {
                  content: [
                    {
                      type: 'text',
                      text:
                        '(error: this proposal could not be queued for review' +
                        (reason ? ` — ${reason}` : '') +
                        '. Re-read the file and retry.)',
                    },
                  ],
                },
              },
            }
          },
        ],
      },
    ]
  }

  async #runChat(runId, params, controller) {
    const {
      prompt,
      model,
      systemPrompt,
      relayTools,
      vaultPath,
      permissionMode = 'bypassPermissions',
      effort,
      fastMode,
      sessionId,
      resume,
      maxTurns,
      builtinTools,
      // Security lockdown: block network egress + secret-file reads so a
      // prompt injection in captured content can't exfiltrate. Defaults ON
      // (secure by default); the host forwards the user's Settings toggle.
      sandboxEnabled = true,
      // Whether this run may DELEGATE (Task) or activate skills (Skill).
      // Defaults ON for the trusted chat/plan surfaces. The host sets it
      // false for untrusted-content shapes (capture/intake): those pass a
      // deliberately narrow builtinTools allowlist, and re-adding Task here
      // would let injected content spawn a full-toolset subagent, defeating
      // the least-privilege set. Least privilege must be transitive.
      allowDelegation = true,
    } = params

    // Plan-mode interactive gate (canUseTool) state. `awaitingDecision` pauses
    // the idle watchdog while a decision (plan approval / clarifying question)
    // is parked on the user. `activeStream` is the live query, captured in the
    // attempt loop so the gate can call setPermissionMode on plan approval.
    let awaitingDecision = 0
    let activeStream = null
    // The cancel handler reads this run's record to decide interrupt vs abort.
    // Wire the awaiting-decision predicate now (closes over awaitingDecision);
    // `stream` is set after each query() below.
    const cancelRec = this.activeChats.get(runId)
    if (cancelRec) cancelRec.isAwaiting = () => awaitingDecision > 0
    // Flipped true once the user approves an ExitPlanMode plan — after which
    // the gate stops denying the propose_* write relays so the model can
    // execute the approved plan.
    let planApproved = false

    const options = {
      permissionMode,
      // Required companion to `bypassPermissions` (sdk.d.ts: "Must be set to
      // `true` when using permissionMode: 'bypassPermissions'"). Set
      // unconditionally: it's a host-level opt-in to bypass, inert under
      // plan/default (never forces bypass). Behaviour is unchanged today —
      // this just closes the forward-compat gap if the SDK begins enforcing it.
      allowDangerouslySkipPermissions: true,
      abortController: controller,
      // Emit `stream_event` notifications token-by-token instead of one
      // SDKAssistantMessage per turn. The frontend reassembles the live
      // text from content_block_delta events.
      includePartialMessages: true,
      // Forward each subagent's full text/thinking (not just the heartbeat
      // counters) as messages tagged with `parent_tool_use_id`, so the host can
      // nest each Task lane's real transcript (its reads/thinking/tool calls).
      // Without this, parallel fan-out shows only a "N tools · last: Read"
      // heartbeat per lane. Increases event volume — every subagent step
      // streams — which is the deliberate cost of the drill-down view.
      forwardSubagentText: true,
      // Periodic AI-generated progress summaries for running subagents — a short
      // present-tense line ("Analyzing the wiki structure…") emitted on
      // `task_progress.summary` every ~30s, so each lane shows what it's DOING
      // in human terms instead of only a "N tools · last: Read" counter. Forks
      // the subagent's cached context, so cost is minimal.
      agentProgressSummaries: true,
      // Adaptive thinking WITH visible summarized reasoning. Thinking is already
      // on (Claude Code default), but Opus 4.7/4.8 omit the reasoning text by
      // default — so the model reasons but our ThinkingPill gets empty content.
      // `display: 'summarized'` returns a short summary of that reasoning, so the
      // "thinking" the user sees is real, not a placeholder.
      thinking: { type: 'adaptive', display: 'summarized' },
      // Auto-summarize older turns once context approaches the model
      // limit, instead of erroring out. autoCompactEnabled lives in
      // Settings (sdk.d.ts:5073) — surfaced via the `settings` flag
      // layer, which has higher precedence than user settings.json.
      // The cacheable system-prompt prefix (belief + role) is preserved
      // across compaction; only mid-conversation turns get summarized.
      // fastMode (faster output on supporting models) is a `Settings` member,
      // same layer as autoCompactEnabled. Only set when requested; the host
      // already gated on model support.
      settings: {
        autoCompactEnabled: true,
        ...(fastMode ? { fastMode: true } : {}),
        // Deny rules win before the canUseTool gate (and under bypass) —
        // hard-block the network-egress shells AND secret-file reads
        // regardless of mode. The secret rules are what actually stop the
        // in-process Read/Glob tools (the sandbox denyRead only reaches
        // subprocesses); they also hold when the sandbox can't initialise.
        ...(sandboxEnabled
          ? {
              permissions: {
                deny: [...egressDenyRules(), ...envDumpDenyRules(), ...secretDenyRules()],
              },
            }
          : {}),
      },
      // Disable the SDK's filesystem settings auto-load (CLAUDE.md,
      // .claude/settings.json, etc.). The host injects the vault's
      // CLAUDE.md explicitly as part of `systemPrompt` so the cache
      // boundary stays under our control and we don't risk double-
      // injecting the same content via two paths. Pass `[]` for
      // full SDK isolation mode — the docs (sdk.d.ts:1637) call
      // this out explicitly as the right move when the host has its
      // own schema-injection pipeline.
      settingSources: [],
    }
    // OS sandbox (kernel-level) — closes the shell-egress paths the deny
    // rules can't (nc, python -c, etc.) and denies secret-file reads.
    if (sandboxEnabled) options.sandbox = sandboxLockdown()
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
    // Cap the agent loop. Forwarded as-is to the SDK (sdk.d.ts:1412
    // — `Maximum number of conversation turns before the query
    // stops`). Used by the ingest path so a runaway tool-calling
    // pass settles instead of churning forever; chat leaves it
    // undefined for normal multi-turn behaviour.
    if (typeof maxTurns === 'number' && maxTurns > 0) options.maxTurns = maxTurns
    // Dev only: host points us at the .pnpm-store copy of the platform-specific
    // claude binary. Prod ships the binary inside our own node_modules, so the
    // SDK auto-resolves and the env var is intentionally unset.
    if (process.env.CLAUDE_CODE_CLI_PATH) {
      options.pathToClaudeCodeExecutable = process.env.CLAUDE_CODE_CLI_PATH
    }

    // The SDK consults `canUseTool` under 'plan' and 'default' modes, but NOT
    // 'bypassPermissions' (which short-circuits every check). So the gate is
    // attached for both interactive modes:
    //   - 'default' (normal chat): pause ONLY on AskUserQuestion so the model
    //     can ask the user mid-turn; every other tool passes straight through
    //     (read / web / propose_* all run as before).
    //   - 'plan': additionally enforce read-only — deny propose_* and vault
    //     writes until ExitPlanMode is approved (then `planApproved` opens them
    //     and the mode flips to 'default').
    // AskUserQuestion / ExitPlanMode park on the user via #requestDecision
    // (chat/permission → user → chat/decision).
    if (permissionMode === 'plan') {
      // The full plan lands in ExitPlanMode's `plan` argument — the single
      // source the host renders — because PLAN_MODE_INSTRUCTIONS steers the
      // model to put it there (prose, no diff blocks) and the SDK wraps those
      // instructions with its own read-only + ExitPlanMode protocol.
      options.planModeInstructions = PLAN_MODE_INSTRUCTIONS
    }
    if (permissionMode === 'plan' || permissionMode === 'default') {
      options.canUseTool = async (toolName, input) => {
        // AskUserQuestion — pause for the user in BOTH plan and chat, then
        // inject the answer. `answers` = per-question choices; `response` = a
        // free-form reply the user typed instead ("Or reply directly…"); when
        // set the model receives "The user responded: …" rather than the
        // structured answers.
        if (toolName === 'AskUserQuestion') {
          awaitingDecision++
          try {
            const decision = await this.#requestDecision(runId, toolName, input, controller)
            const updatedInput = {
              questions: input.questions,
              answers: decision?.answers ?? {},
            }
            if (decision?.response) updatedInput.response = decision.response
            return { behavior: 'allow', updatedInput }
          } finally {
            awaitingDecision--
          }
        }

        // Normal chat: every other tool runs unchanged (this is the allow-all
        // catch-all that keeps 'default' behaving like the old bypass path).
        if (permissionMode !== 'plan') {
          return { behavior: 'allow', updatedInput: input }
        }

        // ── Plan-mode read-only enforcement below ──
        if (toolName === 'ExitPlanMode') {
          awaitingDecision++
          try {
            const decision = await this.#requestDecision(runId, toolName, input, controller)
            // Approve → leave plan mode (switch to 'default') and flip
            // planApproved so the propose_* relays are allowed below. Reject →
            // feed the message back so the model revises the plan.
            if (decision?.type === 'approve') {
              planApproved = true
              if (activeStream) {
                try {
                  await activeStream.setPermissionMode('default')
                } catch (e) {
                  logErrorContext('setPermissionMode', runId, e, { mode: this.mode })
                }
              }
              return { behavior: 'allow', updatedInput: input }
            }
            return {
              behavior: 'deny',
              message:
                decision?.message ||
                'The user asked you to revise the plan before proceeding.',
            }
          } finally {
            awaitingDecision--
          }
        }
        if (typeof toolName === 'string' && toolName.includes('propose_')) {
          // Blocked while planning; allowed once the plan is approved so the
          // model can execute it. Each proposal still surfaces as a Keep/Reject
          // card on the host — approval gates the batch, not each edit.
          if (planApproved) return { behavior: 'allow', updatedInput: input }
          return {
            behavior: 'deny',
            message:
              'Plan mode is read-only. Lay out the full plan, then call ExitPlanMode to proceed.',
          }
        }
        // Built-in write tools: in plan mode the model uses Write to record its
        // plan to the plan file (the canonical flow). Allow that — but ONLY
        // under the plans directory — and deny writes to the vault, so the
        // source stays read-only even though the Write tool is on the surface.
        if (
          toolName === 'Write' ||
          toolName === 'Edit' ||
          toolName === 'MultiEdit' ||
          toolName === 'NotebookEdit'
        ) {
          const filePath = typeof input?.file_path === 'string' ? input.file_path : ''
          if (isInsidePlansDir(filePath)) {
            return { behavior: 'allow', updatedInput: input }
          }
          return {
            behavior: 'deny',
            message:
              'Plan mode is read-only. Put the plan in ExitPlanMode instead of editing files.',
          }
        }
        return { behavior: 'allow', updatedInput: input }
      }
    }

    // When the host gives us a vaultPath, root the agent in the vault and
    // turn on Claude Code's built-in toolset so the model reads and edits
    // vault .md files through the tools it already knows from Claude Code.
    //
    // Notes:
    //   * `cwd` scopes the Read/Edit tools' implicit path resolution to
    //     the vault and is also what the SDK uses as the per-session
    //     working directory anchor.
    //   * `tools: { preset: 'claude_code' }` enables the same toolset
    //     Claude Code ships with. We don't pass `allowedTools` because
    //     the global `permissionMode = 'bypassPermissions'` already
    //     auto-runs every tool call without prompting the user.

    // Existing skills (name + description), populated below when a vault is
    // present. propose_skill shows this list to the model so it can decide
    // UPDATE-an-existing vs create-NEW instead of minting near-duplicates.
    let existingSkills = []
    if (vaultPath) {
      options.cwd = vaultPath
      // Built-in tool exposure is per-caller, and the write surface is
      // deliberately narrow. The chat host passes an explicit `builtinTools`
      // allowlist WITHOUT the write-side tools (Edit / Write / MultiEdit /
      // NotebookEdit) — disk-changing intent instead flows through the
      // host-applies `propose_*` MCP tools (registered in the relay loop
      // below), which emit a `chat/edit-pending` notification and return
      // immediately without parking a Promise; the host queues the proposal
      // in `pendingChangesStore` and applies it on user Keep. Ingest is a
      // background flow pinned to a read-only subset (Read / Glob / Grep)
      // that emits the same `propose_*` proposals.
      //
      // `tools: ['Read', ...]` (explicit array) is the SDK's "least
      // privilege" surface (sdk.d.ts:1211) — listed tools are the only ones
      // the model sees, so Edit/Write are not just denied but invisible.
      // When the caller omits `builtinTools` the full `claude_code` preset
      // is used instead.
      options.tools = Array.isArray(builtinTools) && builtinTools.length > 0
        ? builtinTools
        : { type: 'preset', preset: 'claude_code' }
      // permissionMode stays 'bypassPermissions' (its default) so the SDK
      // auto-runs the read-side tools without a CLI prompt. No `canUseTool`
      // callback is needed for edits — the write tools aren't on the surface
      // at all, so there's nothing to gate. (Bypass short-circuits the
      // permission check entirely — sdk.d.ts L1806 — which is why the write
      // tools are withheld rather than gated. The `canUseTool` callback that
      // IS attached under 'plan'/'default' handles AskUserQuestion and the
      // plan-approval flow, not edits.)

      // Register the vault's agent plugin (`_system/agent`). The SDK loads its
      // `commands/`, `agents/`, and `skills/` NATIVELY — the canonical way, no
      // hand-rolled loaders. Agent roles become delegatable subagents the main
      // agent invokes via the Task tool (as `writer-agent-skills:<name>`); no
      // manual `options.agents`. Skills are still enabled by an explicit
      // allowlist (NOT `'all'`, which would also pull Claude Code's bundled
      // skills — loop / schedule / ... — into context). `settingSources` stays
      // `[]`, so skills/agents/commands arrive via the plugin path alone and our
      // injected CLAUDE.md / cache discipline is untouched. Progressive
      // disclosure: only each skill's/agent's name+description sits in context
      // until the model activates it. Additive: no plugin dir → the `readdir`
      // throws, we swallow it, and nothing about the call changes.
      try {
        const pluginRoot = join(vaultPath, '_system/agent')
        await readdir(pluginRoot) // throws if the plugin dir is absent
        options.plugins = [{ type: 'local', path: pluginRoot }]
        // The `Skill` + `Task` tools must be exposed for plugin skills to
        // activate and for the model to delegate to plugin agents. The chat
        // shape passes an explicit builtinTools allowlist
        // (['Read','Glob','Grep','Bash']) that omits both; the preset shape
        // ({type:'preset',...}) already includes them, so only the array case
        // needs patching. Gated on `allowDelegation`: an untrusted-content
        // shape (intake) withholds Task on purpose, and we must NOT re-add it
        // here — otherwise injected content could Task-delegate to a
        // full-toolset subagent and escape the least-privilege set.
        if (allowDelegation && Array.isArray(options.tools)) {
          for (const t of ['Skill', 'Task']) {
            if (!options.tools.includes(t)) options.tools = [...options.tools, t]
          }
        }
        // Enable the vault's skills by name (allowlist) and read each SKILL.md's
        // frontmatter name + description so propose_skill can present the
        // existing library to the model for its UPDATE/NEW decision. A skill
        // folder without a readable SKILL.md is skipped (it still loads via the
        // plugin path).
        try {
          const skillsRoot = join(pluginRoot, 'skills')
          const skillNames = (await readdir(skillsRoot, { withFileTypes: true }))
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
          if (skillNames.length > 0) {
            options.skills = skillNames
            for (const dir of skillNames) {
              try {
                const raw = await readFile(join(skillsRoot, dir, 'SKILL.md'), 'utf-8')
                const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''
                const pick = (k) =>
                  fm
                    .split('\n')
                    .find((l) => l.startsWith(`${k}:`))
                    ?.slice(k.length + 1)
                    .trim()
                    .replace(/^["']|["']$/g, '') ?? ''
                existingSkills.push({ name: pick('name') || dir, description: pick('description') })
              } catch {
                // Unreadable SKILL.md — skip; it just won't appear in the
                // dedup list shown to the model.
              }
            }
          }
        } catch {
          // No `skills/` subdir → plugin still loads commands + agents.
        }
      } catch {
        // No `_system/agent` plugin dir (or unreadable) → no plugin, no change
        // to the SDK call.
      }
    }

    // Wire relay tools: each one runs inside this sidecar but its handler
    // just forwards args to the host as a `chat/proposal`-shaped event and
    // returns a brief ack so the model can continue. The actual editor /
    // UI work happens in the frontend.
    const enabledRelay = Array.isArray(relayTools)
      ? relayTools
      : (this.mode === 'chat' ? [] : [])
    // Legacy path: runId is fixed for this single-turn run, so the getter is
    // constant. (The persistent path passes `() => rec.currentRunId` so each
    // turn's relay calls tag the runId that's live at emit time.)
    const relayServer = this.#buildRelayServer(
      enabledRelay,
      () => runId,
      vaultPath,
      existingSkills,
    )
    if (relayServer) options.mcpServers = { 'writer-relay': relayServer }

    // propose_edit/write/multi_edit report success to the model the instant
    // they emit `chat/edit-pending` — before the host has actually mapped the
    // proposal into pendingChangesStore. A PostToolUse hook (not a change to
    // the tool handlers themselves — one shared check, not duplicated per
    // tool) confirms the host actually queued it before the model treats it
    // as settled: if the host's ack (chat/edit-ack, sent once agent/chat/
    // index.ts's edit-pending handling resolves) says it failed — or never
    // arrives within the matcher's timeout — this REWRITES the tool's
    // already-returned "queued" text into a visible error, so the model can
    // react (retry, re-read the file, tell the user) instead of believing a
    // proposal exists when it doesn't. Registered unconditionally (not inside
    // the `canUseTool` block above) — it must run in EVERY permission mode,
    // including 'bypassPermissions', since eager-success is a correctness
    // gap independent of the approval flow.
    options.hooks = { PostToolUse: this.#postToolUseHooks() }

    // Up to two attempts: if the first fails with AUTH, ask the host for a
    // fresh token and retry once. Any other error (or a second AUTH) ends
    // the chat.
    let lastResult = null
    let lastContextUsage = null
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
      // Most specific API-level error seen this attempt (SDKAssistantMessageError);
      // refines a generic execution-error result subtype at settle time.
      let lastAssistantError = null
      // Rate-limit signal observed this attempt. `lastRateLimitInfo` is the SDK's
      // rich `rate_limit_event.rate_limit_info` (status / resetsAt / rateLimitType
      // / overage); `sawRateLimitRetry` records that the SDK auto-retried a 429 —
      // together they let us classify a rate-limit-driven failure as RATE_LIMIT
      // even when the final thrown error is a 5xx. `rateLimitRejected` flags a hard
      // quota rejection we fail-fast on (see the event loop).
      let lastRateLimitInfo = null
      let sawRateLimitRetry = false
      let rateLimitRejected = false
      lastResult = null
      lastContextUsage = null
      // Inactivity watchdog. The Claude Agent SDK delegates the actual HTTPS
      // request to a `claude` CLI subprocess; if the network drops mid-stream
      // (Wi-Fi off, ISP hang) the subprocess sits waiting on TCP, no events
      // arrive, and `for await` blocks forever. We watch wall-clock gap
      // between events and abort if it exceeds IDLE_MS — that kills the
      // subprocess and surfaces the failure through the normal error path.
      //
      // This is a *snappier* safety net layered on top of the Anthropic
      // client's own 10-minute request timeout (DEFAULT_TIMEOUT=600000), so it
      // must sit comfortably ABOVE realistic model pauses and well BELOW that
      // backstop. The first content token of a large tool input (e.g.
      // propose_write of a full manuscript chapter) can lag the rest of the
      // stream — measured gaps reached ~50s before the model starts emitting
      // the `content` field. 45s sat *inside* that window and was killing live
      // turns mid-generation (surfacing as a spurious "red line"). 180s clears
      // the observed worst case with generous margin (this user writes long
      // files / high effort, whose pre-content gap can run longer) while still
      // erroring 3× faster than the SDK's backstop; the user can cancel sooner
      // manually either way.
      const IDLE_MS = 180_000
      let idleTimedOut = false
      let lastEventAt = Date.now()
      const watchdog = setInterval(() => {
        if (controller.signal.aborted) return
        // Paused while a decision (plan approval / clarifying question) is
        // parked on the user — no events flow during the wait, and the user
        // may take as long as they like. Keep lastEventAt fresh so the turn
        // doesn't time out the instant the decision resolves.
        if (awaitingDecision > 0) {
          lastEventAt = Date.now()
          return
        }
        if (Date.now() - lastEventAt > IDLE_MS) {
          idleTimedOut = true
          controller.abort()
        }
      }, 5_000)
      // STEP 3: streaming-input mode. Passing `prompt` as an async iterable
      // (not a bare string) keeps the SDK control channel open — the only
      // way to issue control requests like getContextUsage(). The generator
      // yields the single user message, then parks on `inputClosed` so the
      // query stays alive; we release it AFTER fetching the context breakdown
      // at result time, so the subprocess tears down only once we're done.
      // Releasing naively (returning right after the yield) closes the query
      // before the result lands — see the spike notes in
      // docs/llm-control-surface.md.
      let releaseInput
      const inputClosed = new Promise((resolve) => {
        releaseInput = resolve
      })
      const makeInput = async function* () {
        yield {
          type: 'user',
          message: { role: 'user', content: prompt },
          parent_tool_use_id: null,
        }
        await inputClosed
      }
      try {
        activeStream = query({ prompt: makeInput(), options })
        if (cancelRec) cancelRec.stream = activeStream // for graceful interrupt()
        for await (const event of activeStream) {
          if (controller.signal.aborted) break
          lastEventAt = Date.now()
          this.emit(notification('chat/event', { runId, event }))
          // SDKAssistantMessage may carry a structured `error` (rate_limit,
          // server_error, …) mid-turn — capture the latest for settle-time mapping.
          if (event?.type === 'assistant' && event.error) {
            lastAssistantError = event.error
          }
          // The SDK auto-retried a 429 — remember that the failure was
          // rate-limit-driven even if a later attempt fails with a 5xx.
          if (
            event?.type === 'system' &&
            event.subtype === 'api_retry' &&
            event.error === 'rate_limit'
          ) {
            sawRateLimitRetry = true
          }
          // Subscription rate-limit signal (claude.ai). Carries status / resetsAt
          // / rateLimitType. A `rejected` status is a hard quota cap that won't
          // clear within the SDK's retry window (~10 attempts over minutes), so
          // fail fast: abort now and surface the reset time instead of grinding
          // futile retries. A non-rejected event (allowed_warning) is just a
          // heads-up — keep it for settle-time but don't abort.
          if (event?.type === 'rate_limit_event' && event.rate_limit_info) {
            const info = event.rate_limit_info
            lastRateLimitInfo = info
            // Fail fast on a hard cap that won't clear within the SDK's retry
            // window: the windowed limit is `rejected`, OR the overage (paid)
            // budget is actively in use and itself `rejected`. The overageInUse
            // guard keeps a mere overage warning (while the windowed budget
            // still has room) from wrongly aborting a chat that would succeed.
            const overageBlocked = info.overageInUse && info.overageStatus === 'rejected'
            if (info.status === 'rejected' || overageBlocked) {
              rateLimitRejected = true
              controller.abort()
              break
            }
          }
          if (event?.type === 'result') {
            lastResult = event
            // Fetch the per-category context breakdown while the input is
            // still open (control requests need a live streaming session).
            // Best-effort: on any failure the host falls back to the `usage`
            // totals also carried on chat/done.
            try {
              lastContextUsage = await activeStream.getContextUsage()
            } catch (err) {
              logErrorContext('getContextUsage', runId, err, { mode: this.mode })
              lastContextUsage = null
            }
            releaseInput() // close input → query ends
            // Result in hand — leave the loop now. Waiting for the next
            // iteration risks the top-of-loop abort check discarding a result
            // that already landed (a watchdog/cancel firing in the same tick).
            break
          }
        }
      } catch (err) {
        streamError = err
      } finally {
        clearInterval(watchdog)
        releaseInput() // never leave the input generator parked
      }

      // Fail-fast on a hard rate-limit rejection (see the event loop). We aborted
      // the controller, so without this the generic-abort branch below would
      // mislabel it CANCELLED. Surface RATE_LIMIT with the SDK's reset info so the
      // card shows when the quota resets instead of grinding ~10 futile retries.
      if (rateLimitRejected) {
        this.#emitChatError(
          runId,
          'RATE_LIMIT',
          'rate limited',
          true,
          rateLimitPayload(lastRateLimitInfo),
        )
        this.activeChats.delete(runId)
        return
      }

      // A result already in hand means the turn completed — prefer it over an
      // abort that raced in at the same tick. Without the `!lastResult` guard, a
      // watchdog/cancel firing exactly as the final result lands would surface a
      // spurious timeout/cancel on a turn that actually finished.
      if (controller.signal.aborted && !lastResult) {
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

      // A graceful interrupt() can let a clean `result` land before the
      // backstop abort fires — but the user pressed Stop, so settle as
      // CANCELLED regardless of what arrived.
      if (cancelRec?.cancelRequested) {
        this.#emitChatError(runId, 'CANCELLED', 'cancelled by client', false)
        this.activeChats.delete(runId)
        return
      }

      if (streamError) {
        let code = classifyError(streamError)
        // The final thrown error can be a 5xx even though rate limiting is what
        // actually blocked the run (the SDK retried 429s; the last attempt just
        // happened to fail with a 529). Prefer RATE_LIMIT when the run's
        // rate-limit history says so, so we don't surface a misleading
        // "service is busy" with no reset countdown.
        if (
          code !== 'RATE_LIMIT' &&
          (lastRateLimitInfo?.status === 'rejected' || sawRateLimitRetry)
        ) {
          code = 'RATE_LIMIT'
        }
        logErrorContext('stream-error', runId, streamError, {
          attempt,
          code,
          mode: this.mode,
          model,
        })
        if (code === 'AUTH' && attempt === 1) {
          // Pause: ask the host to push a fresh token and retry once.
          this.emit(notification('auth/refreshNeeded', { runId }))
          try {
            await this.#waitForTokenUpdate(5000)
            // Continue the session instead of recreating it: if attempt 1 got
            // far enough to persist the session, switch create→resume so we
            // pick up after the last saved turn (no re-streamed/duplicated
            // output, no same-id create collision — R2/R3). We only do this
            // when the session file is actually on disk; otherwise there's
            // nothing to resume, so we recreate exactly as before. Worst case
            // is unchanged from today (retry fails → 2-attempt cap).
            if (options.sessionId && (await sessionPersisted(options.sessionId))) {
              options.resume = options.sessionId
              delete options.sessionId
            }
            continue // attempt 2 with the rotated token
          } catch {
            // No fresh token in time; fall through to error.
          }
        }
        this.#emitChatError(
          runId,
          code,
          streamError?.message ?? String(streamError),
          !NON_RETRYABLE_CODES.has(code),
          code === 'RATE_LIMIT' ? rateLimitPayload(lastRateLimitInfo) : undefined,
        )
        this.activeChats.delete(runId)
        return
      }

      // Structured error result (G1/G2): the SDK delivered a `result` whose
      // `is_error`/`subtype` marks failure. Surface it as a typed chat/error
      // instead of treating the turn as done (which rendered as an "empty
      // turn"). `lastAssistantError` refines a generic execution-error subtype.
      if (
        lastResult &&
        (lastResult.is_error || String(lastResult.subtype ?? '').startsWith('error_'))
      ) {
        let { code, message, retryable } = mapSdkError({
          subtype: lastResult.subtype,
          assistantError: lastAssistantError,
          errors: lastResult.errors,
        })
        // Same rate-limit-truth preference as the streamError path.
        if (
          code !== 'RATE_LIMIT' &&
          (lastRateLimitInfo?.status === 'rejected' || sawRateLimitRetry)
        ) {
          code = 'RATE_LIMIT'
          message = 'rate limited'
          retryable = true
        }
        this.#emitChatError(
          runId,
          code,
          message,
          retryable,
          code === 'RATE_LIMIT' ? rateLimitPayload(lastRateLimitInfo) : undefined,
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
        // STEP 3: full per-category breakdown from getContextUsage(), or null
        // when the control request failed (host falls back to `usage`).
        contextUsage: lastContextUsage,
        // Actual fast-mode state for the turn (on / cooldown / off). `cooldown`
        // means a rate limit forced it off despite the request.
        fastModeState: lastResult?.fast_mode_state ?? null,
      }),
    )
    this.activeChats.delete(runId)
  }

  #emitChatError(runId, code, message, retryable, rateLimit, threadId) {
    this.emit(
      notification('chat/error', { runId, code, message, retryable, rateLimit, threadId }),
    )
  }

  // Park a canUseTool gate: emit a `chat/permission` notification carrying the
  // tool + input, and return a Promise that resolves when the host sends the
  // matching `chat/decision`. Rejected if the run is cancelled while waiting
  // (the controller.abort listener), so a pending gate never leaks.
  #requestDecision(runId, toolName, input, controller) {
    return new Promise((resolve, reject) => {
      const decisionId = globalThis.crypto.randomUUID()
      const onAbort = () => {
        this.pendingDecisions.delete(decisionId)
        reject(new DOMException('cancelled while awaiting user decision', 'AbortError'))
      }
      this.pendingDecisions.set(decisionId, {
        resolve: (d) => {
          controller.signal.removeEventListener('abort', onAbort)
          resolve(d)
        },
        reject: (e) => {
          controller.signal.removeEventListener('abort', onAbort)
          reject(e)
        },
      })
      controller.signal.addEventListener('abort', onAbort, { once: true })
      this.emit(notification('chat/permission', { runId, decisionId, toolName, input }))
    })
  }

  // Host's answer to a parked gate. Resolves the matching pending decision so
  // canUseTool returns and the SDK continues. Unknown / already-settled ids
  // are ignored.
  #handleDecision(params) {
    const decisionId = params?.decisionId
    if (typeof decisionId !== 'string') return
    const pending = this.pendingDecisions.get(decisionId)
    if (!pending) return
    this.pendingDecisions.delete(decisionId)
    pending.resolve(params?.decision ?? {})
  }

  // Open a slot for a propose_* tool call's host-ack, keyed by the pendingId
  // it just emitted in its `chat/edit-pending` notification. Called from the
  // tool handler itself (buildProposeEditTool etc.), right after emitting —
  // NOT awaited there; only the PostToolUse hook reads this slot's promise.
  #registerAckSlot(pendingId) {
    let resolve
    const promise = new Promise((r) => {
      resolve = r
    })
    this.pendingAcks.set(pendingId, { promise, resolve })
  }

  // Host's answer to "did this propose_* proposal actually get queued?"
  // (agent/chat/index.ts sends this once its edit-pending handling settles).
  // Resolves the matching PostToolUse hook's wait (see #buildPostToolUseHooks).
  // Unknown / already-settled / already-timed-out pendingIds are ignored —
  // the hook's own `timeout` (SDK-native, on the matcher) is what fires if
  // this never arrives, so a late or duplicate ack is just a harmless no-op.
  #handleEditAck(params) {
    const pendingId = params?.pendingId
    if (typeof pendingId !== 'string') return
    const pending = this.pendingAcks.get(pendingId)
    if (!pending) return
    this.pendingAcks.delete(pendingId)
    pending.resolve({ ok: !!params?.ok, reason: params?.reason ?? null })
  }

  #handleCancel(params) {
    const runId = params?.runId
    if (typeof runId !== 'string') return

    // Persistent path: the runId maps to a thread. Cancel the TURN only — keep
    // the thread query (and any in-flight background tasks) alive.
    const threadId = this.runToThread.get(runId)
    if (threadId) {
      this.#cancelPersistentTurn(runId, threadId)
      return
    }

    // Legacy path: cancel the single-turn run.
    const rec = this.activeChats.get(runId)
    if (!rec) return
    // Mark intent so a graceful interrupt that still lands a result settles as
    // CANCELLED (see the cancelRequested check in #runChat).
    rec.cancelRequested = true

    // Parked on a user decision → the model isn't generating; interrupt() is a
    // no-op. Only aborting the controller unparks the canUseTool waiter (via
    // the controller.signal listener installed in #requestDecision).
    if (rec.isAwaiting?.()) {
      rec.controller.abort()
      return
    }

    // Generating → ask the SDK to stop gracefully at a safe boundary (keeps the
    // session intact). Guarantee termination with a hard abort if the graceful
    // stop fails or doesn't settle the run within the grace window (e.g. a
    // wedged stream where interrupt() can't round-trip).
    const stream = rec.stream
    if (stream && typeof stream.interrupt === 'function') {
      Promise.resolve()
        .then(() => stream.interrupt())
        .catch((err) => {
          logErrorContext('interrupt', runId, err, { mode: this.mode })
          if (this.activeChats.has(runId)) rec.controller.abort()
        })
      setTimeout(() => {
        if (this.activeChats.has(runId)) rec.controller.abort()
      }, INTERRUPT_GRACE_MS)
    } else {
      rec.controller.abort()
    }
  }

  // Cancel the CURRENT turn of a persistent thread without killing the thread.
  // A graceful interrupt() stops the foreground turn's generation; the SDK
  // settles it to a clean `result`, which #settleTurn maps to CANCELLED
  // (rec.cancelRequested). Background subagent tasks run in the same subprocess
  // and SURVIVE the interrupt (verified) — they keep running and deliver their
  // task_notification. Only a genuinely wedged stream (no result within the
  // grace window) escalates to a hard teardown, and even then ONLY when no
  // background work is in flight (see the backstop), so a cancel never severs a
  // running background task.
  #cancelPersistentTurn(runId, threadId) {
    const rec = this.activeThreads.get(threadId)
    // Stale cancel (turn already settled / different turn now live) → no-op.
    if (!rec || rec.currentRunId !== runId || !rec.turnActive) return
    rec.cancelRequested = true

    // Parked on a user decision (canUseTool) → the model isn't generating.
    // Abort the TURN controller (unparks #requestDecision), NOT the thread
    // controller; then interrupt to stop any follow-on generation.
    if (rec.awaitingDecision > 0) {
      try {
        rec.turnController?.abort()
      } catch {
        // best-effort
      }
    }
    Promise.resolve()
      .then(() => rec.query?.interrupt())
      .catch((e) => logErrorContext('interrupt', runId, e, { mode: this.mode, threadId }))
    setTimeout(() => {
      // If the turn is still live after the grace window, interrupt didn't
      // round-trip. Settle CANCELLED either way. Hard-close the thread ONLY when
      // no background work is in flight — a running background task means the
      // subprocess must stay up to deliver its result, so we settle the turn but
      // leave the thread alive (the next turn reuses it). If #settleTurn already
      // ran, currentRunId has moved on and this guard skips.
      if (
        this.activeThreads.get(threadId) === rec &&
        rec.currentRunId === runId &&
        rec.turnActive &&
        !rec.terminalEmitted
      ) {
        rec.terminalEmitted = true
        this.#emitChatError(runId, 'CANCELLED', 'cancelled by client', false, undefined, threadId)
        if (this.#backgroundInFlight(rec)) {
          // Keep the thread (and its background tasks) alive; just release the
          // parked turn so the generator can advance to the next one.
          rec.turnActive = false
          this.runToThread.delete(runId)
          rec.currentRunId = null
          const r = rec.turnSettleResolve
          rec.turnSettleResolve = null
          if (r) r()
        } else {
          this.#teardownThread(rec, 'cancel_wedged')
        }
      }
    }, PERSIST_INTERRUPT_GRACE_MS)
  }

  // Real teardown of a persistent thread (archive / doc-close / delete). Distinct
  // from per-turn cancel: ends the long-lived query. The session persists to
  // disk, so a later chat for this threadId resumes cleanly.
  #handleCloseThread(params) {
    const threadId = params?.threadId
    if (typeof threadId !== 'string') return
    const rec = this.activeThreads.get(threadId)
    if (rec) this.#teardownThread(rec, 'closed')
  }

  // Stop a specific in-flight background task (the user hit Stop on its row).
  // The SDK emits a task_notification with status 'stopped', which #trackBackground
  // forwards and clears from backgroundTaskIds.
  #handleStopTask(params) {
    const threadId = params?.threadId
    const taskId = params?.taskId
    if (typeof threadId !== 'string' || typeof taskId !== 'string') return
    const rec = this.activeThreads.get(threadId)
    if (rec?.query && typeof rec.query.stopTask === 'function') {
      Promise.resolve()
        .then(() => rec.query.stopTask(taskId))
        .catch((e) => logErrorContext('stopTask', taskId, e, { mode: this.mode, threadId }))
    }
  }

  // Mid-thread token expiry: the persistent query's env token was fixed at build
  // time, so an AUTH failure can't be fixed by the legacy per-attempt retry.
  // Recreate the thread (resume from the persisted session) with a fresh token
  // and replay the failed turn. One-shot: a second AUTH gives up. Returns true if
  // a restart was launched (caller should NOT also emit the error).
  async #restartThreadForAuth(rec, runId) {
    if (rec.authRetried) return false
    rec.authRetried = true
    const item = rec.currentItem
    this.emit(notification('auth/refreshNeeded', { runId, threadId: rec.threadId }))
    try {
      await this.#waitForTokenUpdate(5000)
    } catch {
      return false // no fresh token in time → let the caller surface AUTH
    }
    if (!item) {
      this.#teardownThread(rec, 'auth_restart')
      return false
    }
    // Recreate resuming the persisted session (with the refreshed token picked
    // up from this.token at build) and replay the turn that 401'd.
    const newRec = await this.#recreateThread(rec, item, rec.optionsSeed, 'auth_restart')
    if (newRec) newRec.authRetried = true // don't loop on a second AUTH after replay
    return true
  }

  async #handleShutdown(id) {
    if (id !== undefined) this.emit(response(id, null))
    this.shutdown()
  }

  /** Graceful teardown, reused by the `shutdown` RPC (host quit) AND the
   * process-signal handlers in index.mjs. Aborting each in-flight chat lets the
   * SDK tear down its `claude` CLI subprocess (so it isn't orphaned) and flush
   * session state to ~/.claude/projects (so resume stays intact), then we exit
   * after a short flush window. Idempotent. */
  shutdown() {
    if (this.shuttingDown) return
    this.shuttingDown = true
    for (const [, rec] of this.activeChats) rec.controller.abort()
    // Persistent-path threads: graceful close (signals the generator to return
    // and aborts the thread controller) so their `claude` children are reaped
    // too. Sessions persist to disk, so nothing is lost.
    for (const [, rec] of this.activeThreads) this.#teardownThread(rec, 'shutdown')
    // Give in-flight chats a moment to flush their CANCELLED notifications and
    // let the SDK reap the CLI child before we exit.
    setTimeout(() => process.exit(0), 250)
  }
}

// How long a graceful interrupt() gets to settle the run before the cancel
// handler forces a hard abort. Short enough to feel instant, long enough for
// the model to reach a safe boundary.
const INTERRUPT_GRACE_MS = 1500

// Persistent path: a more generous interrupt window before the backstop tears
// the thread down. Longer than the legacy value because a premature teardown
// here kills the whole thread (and any in-flight background tasks), so we only
// escalate when the stream is genuinely wedged, not merely slow to settle.
const PERSIST_INTERRUPT_GRACE_MS = 5000

// Persistent-query path (chat mode) resource bounds.
// A live thread query holds a `claude` CLI subprocess open across turns. The
// reaper gracefully closes a thread that's been idle this long WHEN no
// background task is in flight; the next turn resumes it from disk (sessions
// persist under ~/.claude/projects), so closing is lossless. 5 min clears the
// prompt cache but keeps a subprocess from lingering for a walked-away user.
const IDLE_TTL_MS = 300_000
// Each live thread = one subprocess. Cap concurrent live threads; on overflow
// the LRU idle, background-free thread is evicted (it resumes from disk on its
// next turn). A thread that's mid-turn or has background work is never evicted.
const MAX_LIVE_THREADS = 6

// Persistent path: max wall-clock gap between events WITHIN an active turn
// before we treat the turn as network-wedged and hard-close the thread (it
// resumes from disk next turn). Mirrors the legacy #runChat IDLE_MS (180s) —
// snappier than the SDK's 10-min backstop, above realistic model pauses. Only
// armed while a turn is generating; an idle-but-alive thread never times out.
const TURN_IDLE_MS = 180_000

