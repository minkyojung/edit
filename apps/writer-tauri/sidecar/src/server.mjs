import { readdir } from 'node:fs/promises'
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
import { readSkillMeta } from './frontmatter.mjs'
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
} from './tools/relay.mjs'


/** Attach the CLI's own stderr tail to an error message.
 *
 * "Claude Code process exited with code 1" names the symptom and discards the
 * cause. The CLI had already printed the cause — five harnesses were dying on
 * "Error: Invalid session ID. Must be a valid UUID." — and nothing carried it
 * out, so a one-line fix read as an unexplained INTERNAL. Only the tail is
 * kept, and only when there is something to say. */
function withCliStderr(message, lines) {
  if (!Array.isArray(lines) || lines.length === 0) return message
  const tail = lines.join('').trim().split('\n').slice(-6).join('\n').trim()
  return tail ? `${message}\n--- claude CLI stderr ---\n${tail}` : message
}

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

function buildSetNoteStatusTool(getRunId, emit) {
  return tool(
    'set_note_status',
    "Set a note's workflow status when the user asks (e.g. \"이거 완료 처리해줘\" → done, \"진행 중으로\" → in-progress, \"아직 시작 안 함\" → not-started). `path` is the note's vault-relative or absolute path; `status` is one of not-started / in-progress / done. Only editable notes carry a status — a daily journal or a system page will be ignored by the host. Applied IMMEDIATELY (not queued for review) and reversible. Returns immediately — do not wait. This is the ONLY way to change a note's status; never write a `status:` line into a `---` frontmatter block yourself.",
    {
      path: z.string(),
      status: z.enum(['not-started', 'in-progress', 'done']),
    },
    async (input) => {
      emit(
        notification('chat/set-status', {
          runId: getRunId(),
          path: input.path,
          status: input.status,
        }),
      )
      return {
        content: [{ type: 'text', text: `Status set: ${input.path} → ${input.status}` }],
      }
    },
  )
}

function buildSetNoteTagsTool(getRunId, emit) {
  return tool(
    'set_note_tags',
    "Set a note's tags when the user asks (e.g. \"이 노트에 태그 달아줘\", \"ai, 금융 태그 붙여줘\"). `path` is the note's vault-relative or absolute path; `tags` is the COMPLETE list of tags the note should have (this REPLACES the existing tags, so include the ones to keep). Pass an empty list to clear all tags. Only editable notes carry tags — a daily journal or system page is ignored by the host. Applied IMMEDIATELY (not queued) and reversible. Returns immediately — do not wait. This is the ONLY way to change a note's tags; never write a `tags:` block into a `---` frontmatter block yourself.",
    {
      path: z.string(),
      tags: z.array(z.string()),
    },
    async (input) => {
      emit(
        notification('chat/set-tags', {
          runId: getRunId(),
          path: input.path,
          tags: input.tags,
        }),
      )
      return {
        content: [
          { type: 'text', text: `Tags set: ${input.path} → [${input.tags.join(', ')}]` },
        ],
      }
    },
  )
}

function buildQueryNotesTool(getRunId, requestQuery) {
  return tool(
    'query_notes',
    "Find notes by their METADATA — workflow status and/or tags — WITHOUT reading files. Use this whenever the user refers to notes by status or tag: \"summarize my in-progress notes\", \"list notes tagged finance\", \"what's not started yet\". `where.status` is one of not-started / in-progress / done; `where.tags` is a list — a note matches if it carries ANY of them (case-sensitive). Returns REFERENCES only — {path, title, status, tags} per note, NEVER the note bodies — so Read the paths you actually want. Do NOT use this for free text inside a note's body (a phrase, a name, a [[wikilink]]) — use Grep for that. Grep is unreliable on the multi-line `tags:` frontmatter block, which is exactly why this tool exists for metadata. If `nextCursor` comes back, pass it as `cursor` to page through more.",
    {
      where: z
        .object({
          status: z.enum(['not-started', 'in-progress', 'done']).optional(),
          tags: z.array(z.string()).optional(),
        })
        .optional(),
      limit: z.number().optional(),
      cursor: z.string().optional(),
    },
    async (input) => {
      try {
        const { results, nextCursor } = await requestQuery(
          input.where ?? {},
          input.limit ?? 50,
          input.cursor ?? null,
        )
        if (results.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No notes matched this metadata filter (status / tags). For free text inside note bodies, use Grep instead.',
              },
            ],
          }
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ results, nextCursor }) }],
        }
      } catch (e) {
        return {
          content: [
            {
              type: 'text',
              text: `(query_notes failed: ${e.message}. Retry, or fall back to Glob/Grep.)`,
            },
          ],
        }
      }
    },
  )
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
    // threadId -> ThreadRec. Every chat runs here: one streaming-input query()
    // per conversation thread, driven by a message queue, so a `result` is a
    // TURN boundary. A 'persist' thread stays alive across turns (background
    // subagent tasks survive); a 'closeAfterResult' thread (title / one-shot)
    // ends after its single result.
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
    // pending`; resolved by `chat/edit-ack`. AWAITED by the tool handler itself,
    // which returns the verdict as its own result — so only that one tool call
    // blocks, never the agent loop's progress on other files.
    this.pendingAcks = new Map()
    // queryId -> { resolve, reject, runId } for an in-flight `query_notes`
    // tool call awaiting the host's filtered result (references). Unlike
    // pendingAcks, the tool handler AWAITS this and returns the payload to the
    // model. Modeled on pendingDecisions (awaited + cancellable + data-carrying).
    this.pendingQueries = new Map()
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
        case 'chat/query-result':
          return this.#handleQueryResult(params)
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
    if (this.runToThread.has(runId)) {
      this.emit(errorResponse(id, INVALID_PARAMS, `runId already active: ${runId}`))
      return
    }
    if (this.mode === 'title' && this.activeThreads.size > 0) {
      this.emit(errorResponse(id, BUSY, 'title sidecar is single-flight'))
      return
    }
    if (this.shuttingDown) {
      this.emit(errorResponse(id, INVALID_REQUEST, 'shutting down'))
      return
    }

    // One thread engine for every chat. The teardown policy is derived from the
    // persistent-query flag: a real persistent chat (flag on, chat mode) keeps
    // its thread alive across turns so background subagents survive turn
    // boundaries ('persist'); everything else — title, and any chat/intake that
    // used to run on the legacy per-turn path — is a one-shot that ends after
    // its single result ('closeAfterResult'). One-shot flows may carry no
    // threadId, so synthesise one from runId. #handleChatPersistent dedups the
    // runId (runToThread) and emits the `accepted` response.
    const teardown = this.#usePersistentQuery(params) ? 'persist' : 'closeAfterResult'
    const threadId = params.threadId ?? params.sessionId ?? params.resume ?? runId
    return this.#handleChatPersistent(id, { ...params, threadId, teardown })
  }

  // Whether this chat keeps a long-lived (persistent) thread. True only for a
  // real chat with the persistent-query flag on; title and the flag-off /
  // no-flag one-shots run on the same engine but with 'closeAfterResult'
  // teardown (they end after one result). Kept as the teardown selector.
  #usePersistentQuery(params) {
    return this.mode === 'chat' && params?.persistentQuery === true
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
      // Every reused turn, not just one that changes a live control — a turn
      // that ONLY changes a frozen param would otherwise pass in silence, which
      // is exactly the shape the effort bug had.
      this.#warnFrozenParamChange(existing, params)
      // A turn that changes model / permissionMode / fastMode / effort reconciles the
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

  // Which chat params a LATER turn can still change, and which are fixed once the
  // thread's query() exists. The split isn't ours to choose — it follows what
  // the SDK exposes as a live control request:
  //
  //   applied per turn        SDK control              #applyThreadControls
  //     model                 setModel
  //     permissionMode        setPermissionMode
  //     fastMode              applyFlagSettings({fastMode})
  //     effort                applyFlagSettings({effortLevel})
  //
  //   fixed at thread creation (no control request exists)
  //     systemPrompt, builtinTools, relayTools, allowDelegation,
  //     sandboxEnabled, vaultPath, maxTurns, gitDir, gitWorkTree
  //
  // The failure mode is silence: the host resends every param on every turn, and
  // the reuse path in #handleChatPersistent simply drops the fixed ones. Nothing
  // errors. `effort` sat broken this way — the dropdown was editable mid-chat and
  // did nothing — until it was measured, because there was no signal and no list
  // like this one to check against.
  //
  // Two of the fixed entries deserve their own note:
  //
  //   systemPrompt is fixed but changes legitimately every turn (the date, the
  //   growing profile), so it is NOT warned about below. Anything in it that
  //   tracks where the user IS must ride the per-turn USER message instead —
  //   see currentNoteBlock / selectionBlock / viewingFileBlock. That is the
  //   whole reason those blocks exist.
  //
  //   builtinTools is fixed, and plan mode narrows it — but plan mode's teeth
  //   are permissionMode, which IS applied per turn. Measured: a thread started
  //   in edit mode and switched to plan attempts Write and the file is not
  //   modified. So the frozen toolset is not a hole.
  //
  // The rest should never differ mid-thread; if one does, the caller has changed
  // something that cannot take effect, and #warnFrozenParamChange says so once.
  static #FROZEN_WARN_PARAMS = [
    'builtinTools',
    'relayTools',
    'allowDelegation',
    'sandboxEnabled',
    'vaultPath',
    'maxTurns',
  ]

  // One line per (thread, param) the first time a later turn tries to change
  // something the SDK gives us no way to change. Warn, don't throw: the turn is
  // still valid, it just runs under the thread's original value — and a hard
  // failure here would break chat for a caller bug that is usually harmless.
  #warnFrozenParamChange(rec, params) {
    const seed = rec.optionsSeed ?? {}
    for (const key of Server.#FROZEN_WARN_PARAMS) {
      const before = JSON.stringify(seed[key] ?? null)
      const after = JSON.stringify(params[key] ?? null)
      if (before === after) continue
      rec.warnedFrozen ??= new Set()
      if (rec.warnedFrozen.has(key)) continue
      rec.warnedFrozen.add(key)
      process.stderr.write(
        `[sidecar frozen-param] threadId=${rec.threadId} ${key} changed mid-thread ` +
          `but is fixed at thread creation — this turn runs with the original value. ` +
          `was=${before.slice(0, 80)} now=${after.slice(0, 80)}\n`,
      )
    }
  }

  // Reconcile a turn's model / permissionMode / fastMode / effort with the live query via
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
    // Both of these live in the SDK's *settings* layer rather than having a
    // dedicated control method, so they share one merge. Sending them together
    // keeps it to a single control round-trip; `applyFlagSettings` shallow-
    // merges by top-level key, so naming only what changed leaves the rest of
    // the flag layer alone.
    const settings = {}
    if (!!params.fastMode !== !!rec.optionsSeed.fastMode) {
      settings.fastMode = !!params.fastMode
    }
    // There is no `setEffort()`, which is easy to read as "effort can't change
    // mid-session" — it can. `Settings.effortLevel` is the documented knob and
    // `applyFlagSettings` is how you reach it on a live query. Verified against
    // the real CLI in both directions (see verify-effort-midthread.mjs): the
    // turn after the call reports the new level in CLAUDE_EFFORT.
    //
    // Our ChatEffort ('low' | 'medium' | 'high' | 'xhigh') is exactly
    // Settings.effortLevel's union, so the value passes through unmapped. Note
    // EffortLevel (the Options.effort type) additionally allows 'max' — if the
    // app ever offers it, it can be set at thread creation but NOT through this
    // path, and would need mapping.
    if (params.effort && params.effort !== rec.optionsSeed.effort) {
      settings.effortLevel = params.effort
    }
    if (Object.keys(settings).length > 0) {
      try {
        await rec.query.applyFlagSettings(settings)
      } catch (e) {
        logErrorContext('applyFlagSettings', rec.currentRunId, e, { mode: this.mode })
      }
    }
    rec.optionsSeed = params // new baseline for the next turn's diff
  }

  // Whether a new turn's model / permissionMode / fastMode / effort differs from the
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
      !!params.fastMode !== !!seed.fastMode ||
      (params.effort ?? null) !== (seed.effort ?? null)
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
        // NOTE: model / permissionMode / fastMode / effort are set at build time (turn 1),
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
      // Teardown policy: 'persist' keeps the thread alive across turns (chat, so
      // background subagents survive turn boundaries); 'closeAfterResult' ends
      // the thread after its first result (title / any one-shot — legacy's
      // per-turn "close at result" semantics). Set once at creation; read by the
      // #runThreadLoop result branch. Defaults to 'persist' — dormant until a
      // caller passes 'closeAfterResult'.
      teardown: params.teardown ?? 'persist',
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
      // Live background work, replaced wholesale from each
      // `background_tasks_changed` event. Empty is the correct start value: the
      // signal is per-process and emits nothing at startup.
      backgroundTaskIds: new Set(),
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

  // Build the query() options for a thread. Reads per-turn-mutable state from
  // `rec` so ONE options object serves every turn. canUseTool + planModeInstructions are attached
  // UNCONDITIONALLY (a later turn may enter plan mode); under bypass the SDK
  // skips the gate, so the common all-bypass thread pays nothing.
  async #buildThreadOptions(rec) {
    const params = rec.optionsSeed
    // vaultPath / builtinTools / relayTools / allowDelegation are read inside
    // #applySkillsAndRelay (from rec.optionsSeed); only the base-options fields
    // are destructured here.
    const {
      model,
      systemPrompt,
      effort,
      fastMode,
      sessionId,
      resume,
      maxTurns,
      sandboxEnabled = true,
      gitDir,
      gitWorkTree,
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
        // UNCONDITIONAL. These govern the in-process tools (Read, Glob) and the
        // network shells; the OS sandbox governs subprocesses. security.mjs
        // states the split and says of this layer: "It also holds when the
        // sandbox can't initialise. Zero dependency."
        //
        // It used to be gated on `sandboxEnabled` alongside options.sandbox,
        // which made that claim false — one flag turned off BOTH layers, so a
        // caller asking to skip the OS sandbox also un-blocked
        // `Read(~/.ssh/id_rsa)`. Eight harnesses pass sandboxEnabled:false and
        // had therefore been running with no secret protection at all.
        permissions: {
          deny: [...egressDenyRules(), ...envDumpDenyRules(), ...secretDenyRules()],
        },
      },
      settingSources: [],
    }
    // Only the OS sandbox is opt-out; the deny rules above are not.
    if (sandboxEnabled) options.sandbox = sandboxLockdown({ gitDir })
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
      // Point the model's `git` at the vault's external repo (host-derived, see
      // claude_chat_start) so plain `git log`/`git revert` from the vault cwd work
      // without a `--git-dir` flag — the vault itself has no `.git`. Only set when
      // the host supplied a vault (chats without one don't touch git).
      ...(gitDir ? { GIT_DIR: gitDir, GIT_WORK_TREE: gitWorkTree } : {}),
    }

    // Gate is always attached (a later turn may switch to plan) and reads rec
    // LIVE. Under bypassPermissions the SDK short-circuits it.
    options.planModeInstructions = PLAN_MODE_INSTRUCTIONS
    options.canUseTool = this.#buildCanUseTool(rec)

    await this.#applySkillsAndRelay(rec, options)
    return options
  }

  // The canUseTool gate for a thread. Always attached (a later turn may switch
  // to plan) and reads `rec` LIVE; under bypassPermissions the SDK
  // short-circuits it. AskUserQuestion / ExitPlanMode park on #requestDecision
  // (which runs in the SDK's tool-callback context — OUTSIDE the input
  // generator — so awaiting it here can never abort the query).
  #buildCanUseTool(rec) {
    return async (toolName, input) => {
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
  }

  // Vault skill/plugin discovery + relay MCP server + hooks. Mutates `options`
  // (cwd/tools/plugins/skills/mcpServers/hooks). Background inventory is wired
  // ONLY through the Stop hook (never query.backgroundTasks()).
  async #applySkillsAndRelay(rec, options) {
    const { vaultPath, builtinTools, allowDelegation = true, relayTools } = rec.optionsSeed
    // Vault: cwd + agent plugin (commands/agents/skills). The toolset is set
    // OUTSIDE that gate — see below.
    let existingSkills = []
    // Honoured whether or not a vault is set: they are independent concerns, and
    // coupling them meant a caller asking for a narrow list but no vaultPath
    // silently received the full CLI default instead.
    //
    // `Array.isArray`, not `.length > 0`. The SDK documents `[]` as "Disable all
    // built-in tools" (sdk.d.ts, `tools?:`) — MCP tools only, the MAXIMALLY
    // restricted state. Treating it as "unspecified" turned that into the full
    // claude_code preset, Edit/Write/Bash included: the most restrictive input
    // producing the most permissive result. Nothing passes `[]` today, but
    // commands.rs forwards `Option<Vec<String>>` verbatim, so `Some([])` reaches
    // here unfiltered.
    options.tools = Array.isArray(builtinTools)
      ? builtinTools
      : { type: 'preset', preset: 'claude_code' }
    if (vaultPath) {
      options.cwd = vaultPath
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
                existingSkills.push(
                  await readSkillMeta(join(skillsRoot, dir, 'SKILL.md'), dir),
                )
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
      existingSkills,
    )
    if (relayServer) options.mcpServers = { 'writer-relay': relayServer }

    // Keep the CLI's own stderr. Without it a startup refusal reaches us only as
    // "Claude Code process exited with code 1" → chat/error INTERNAL, and the
    // actual reason is discarded. That cost an hour today: five harnesses were
    // dying on a one-line message the SDK had already printed —
    //   Error: Invalid session ID. Must be a valid UUID.
    // — which nothing surfaced. Bounded to the tail because a debug-heavy run
    // can emit a lot, and only the last lines carry the failure.
    const cliStderr = []
    options.stderr = (d) => {
      cliStderr.push(String(d))
      if (cliStderr.length > 40) cliStderr.shift()
    }
    rec.cliStderr = cliStderr

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
          if (rec.turnActive) {
            // One-shot policy ('closeAfterResult'): end the thread after this
            // result. Set closeRequested BEFORE #settleTurn — settle fetches
            // context usage (input still open) then releases #threadInput's
            // settle park; the generator loops to its top-of-loop closeRequested
            // check (which must already be true) and returns → input ends → the
            // query ends cleanly → the loop's finally finalizes teardown. Setting
            // it AFTER settle would race the generator re-parking onto the next
            // turn. This makes legacy's "getContextUsage → releaseInput → break"
            // an emergent behaviour of the one engine, not a second code path.
            if (rec.teardown === 'closeAfterResult') rec.closeRequested = true
            await this.#settleTurn(rec, event)
          } else {
            this.#settleBackgroundTurn(rec, event)
          }
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
              withCliStderr(err?.message ?? String(err), rec.cliStderr),
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

  // Maintain the thread's live background-work set, and forward every task
  // event on the dedicated chat/task channel.
  //
  // The set comes from ONE source: `background_tasks_changed`, whose contract is
  // "every live background task after the change" with REPLACE semantics. A
  // level signal, not a pair of edges — which is what makes it trustworthy here.
  // Measured on CLI 2.1.220: a `background: true` subagent produces
  // `[{task_id, task_type:'local_agent', …}]` then `[]`; a `run_in_background`
  // Bash produces the same with `task_type:'local_bash'`; and an ordinary
  // BLOCKING subagent produces no event at all, because it isn't background
  // work. That last case is the one that used to need guessing.
  //
  // What this replaced, and why none of it survives:
  //   - a Set built by pairing task_started → task_notification. Blocking
  //     subagents emit the opening edge and never the closing one, so their ids
  //     accumulated and the thread read as permanently busy.
  //   - a classifier that read `background: true` out of the vault's agent files
  //     to decide which task_started counted. A workaround for the SDK not
  //     saying; it now says.
  //   - the Stop hook's `background_tasks` snapshot, ORed in as a second
  //     "authoritative" source. Two sources for one fact is how they drift.
  // Losing the edge-pairing costs nothing: a missed edge can no longer wedge the
  // indicator, since the next membership change re-states the whole set.
  //
  // Per-process by contract: nothing is emitted at startup, so an empty set is
  // the correct initial value — which is what a fresh `rec` already has, and a
  // reaped thread gets a fresh one.
  #trackBackground(rec, event) {
    const st = event.subtype
    if (st === 'background_tasks_changed') {
      rec.backgroundTaskIds = new Set(
        Array.isArray(event.tasks) ? event.tasks.map((t) => t.task_id) : [],
      )
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
    return backgroundInFlight(rec)
  }

  // Whether a thread is doing (or about to do) work and so must NOT be reaped or
  // LRU-evicted. Three signals: a turn is generating (`turnActive`), a turn is
  // queued but not yet picked up (`turnQueue.length` — the settle→re-park window
  // where `#settleTurn` has set turnActive=false but `#threadInput` hasn't yet
  // shifted the next item), or background subagent work is live. Missing the
  // queued-turn signal is the turn-loss race: an evict in that window tears the
  // thread down and the queued turn vanishes with no terminal for its runId.
  #threadBusy(rec) {
    return threadBusy(rec)
  }

  // Build the `writer-relay` MCP server from the enabled relay-tool names, or
  // null when none are enabled. `getRunId` is a getter (not a value) so each
  // relay call stamps the runId that's live at emit time — constant on the
  // legacy single-turn path, `() => rec.currentRunId` on the persistent path
  // where one server instance serves many turns.
  #buildRelayServer(enabledRelay, getRunId, existingSkills) {
    const relayDefs = []
    for (const name of enabledRelay) {
      if (name === 'propose_edit') {
        relayDefs.push(
          buildProposeEditTool(getRunId, this.emit, (id) => this.#registerAckSlot(id)),
        )
      } else if (name === 'propose_write') {
        relayDefs.push(buildProposeWriteTool(getRunId, this.emit, (id) => this.#registerAckSlot(id)))
      } else if (name === 'propose_skill') {
        relayDefs.push(buildProposeSkillTool(getRunId, this.emit, existingSkills))
      } else if (name === 'propose_multi_edit') {
        relayDefs.push(
          buildProposeMultiEditTool(getRunId, this.emit, (id) =>
            this.#registerAckSlot(id),
          ),
        )
      } else if (name === 'move_note') {
        relayDefs.push(buildMoveNoteTool(getRunId, this.emit))
      } else if (name === 'set_note_status') {
        relayDefs.push(buildSetNoteStatusTool(getRunId, this.emit))
      } else if (name === 'set_note_tags') {
        relayDefs.push(buildSetNoteTagsTool(getRunId, this.emit))
      } else if (name === 'query_notes') {
        relayDefs.push(
          buildQueryNotesTool(getRunId, (where, limit, cursor) =>
            this.#requestQuery(getRunId(), where, limit, cursor),
          ),
        )
      }
    }
    if (relayDefs.length === 0) return null
    return createSdkMcpServer({ name: 'writer-relay', tools: relayDefs })
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

  // Open a slot for a propose_* tool call's host-ack, keyed by the pendingId it
  // is about to emit in its `chat/edit-pending` notification. Every caller
  // registers BEFORE emitting: the host round-trip is fast enough that an ack
  // can land before the emit call returns, and a slot opened afterwards would
  // miss it and fail open on a genuine refusal.
  #registerAckSlot(pendingId) {
    let resolve
    const promise = new Promise((r) => {
      resolve = r
    })
    this.pendingAcks.set(pendingId, { promise, resolve })
    // Callers await `promise` and then call `cleanup`; they hold the promise
    // ref, so deleting the map entry can't lose its value.
    return { promise, cleanup: () => this.pendingAcks.delete(pendingId) }
  }

  // Host's answer to "did this propose_* proposal actually get queued?"
  // (agent/chat/index.ts sends this once its edit-pending handling settles).
  // Resolves the waiting tool handler. Unknown / already-settled / already-
  // timed-out pendingIds are ignored — each handler races its own fail-open
  // timeout, so a late or duplicate ack is a harmless no-op.
  #handleEditAck(params) {
    const pendingId = params?.pendingId
    if (typeof pendingId !== 'string') return
    const pending = this.pendingAcks.get(pendingId)
    if (!pending) return
    // Resolve but DON'T delete — the awaiting handler's `cleanup` is the sole
    // deleter, after it has read the settled value.
    pending.resolve({ ok: !!params?.ok, reason: params?.reason ?? null, applied: !!params?.applied })
  }

  // Ask the host to filter its note catalog by metadata and return references.
  // Awaited by the `query_notes` tool handler, as the propose_* acks are. The
  // host's filter is a near-instant in-memory pass, so a 5s timeout backstop
  // (host never answers) plus per-run rejection on cancel is enough — no
  // controller is threaded through the fire-once relay tools.
  #requestQuery(runId, where, limit, cursor) {
    return new Promise((resolve, reject) => {
      const queryId = globalThis.crypto.randomUUID()
      let timer = null
      const settle = (fn) => (v) => {
        if (timer) clearTimeout(timer)
        this.pendingQueries.delete(queryId)
        fn(v)
      }
      this.pendingQueries.set(queryId, {
        runId,
        resolve: settle(resolve),
        reject: settle(reject),
      })
      timer = setTimeout(() => {
        const q = this.pendingQueries.get(queryId)
        if (q) q.reject(new Error('query_notes: host did not respond in time'))
      }, 5000)
      this.emit(notification('chat/query-notes', { runId, queryId, where, limit, cursor }))
    })
  }

  // Host's filtered result for a parked query_notes call.
  #handleQueryResult(params) {
    const queryId = params?.queryId
    if (typeof queryId !== 'string') return
    const pending = this.pendingQueries.get(queryId)
    if (!pending) return
    pending.resolve({
      results: Array.isArray(params?.results) ? params.results : [],
      nextCursor: params?.nextCursor ?? null,
    })
  }

  #handleCancel(params) {
    const runId = params?.runId
    if (typeof runId !== 'string') return

    // Fail any in-flight query_notes for this run so its slot doesn't linger
    // until the 5s timeout.
    for (const q of this.pendingQueries.values()) {
      if (q.runId === runId) q.reject(new Error('cancelled'))
    }

    // Every chat runs on the thread engine, so the runId maps to a thread.
    // Cancel the TURN only — keep the thread query (and any in-flight background
    // tasks) alive; a one-shot thread then closes after the cancelled result.
    const threadId = this.runToThread.get(runId)
    if (threadId) this.#cancelPersistentTurn(runId, threadId)
  }

  // Cancel the CURRENT turn of a persistent thread without killing the thread.
  // A graceful interrupt() stops the foreground turn's generation; the SDK
  // settles it to a clean `result`, which #settleTurn maps to CANCELLED
  // (rec.cancelRequested). Only a genuinely wedged stream (no result within the
  // grace window) escalates to a hard teardown, and even then ONLY when no
  // background work is in flight (see the backstop).
  //
  // WARNING — in-process background subagents do NOT survive this. An earlier
  // revision of this comment claimed they did ("SURVIVE the interrupt
  // (verified)"); that is false on SDK 0.3.187 / CLI 2.1.187. Measured
  // 2026-07-27: interrupting a foreground turn while a `background: true`
  // subagent is mid-flight kills it — the SDK emits
  // task_updated{status:"killed"} then task_notification{status:"stopped"} for
  // that task in the same tick as the cancel.
  //
  // The cause is upstream and can't be fixed here: the CLI links each task's
  // AbortController as a CHILD of the turn's, so interrupt()'s abort reason
  // cascades into them. It's a regression (0.2.140 preserved them), tracked at
  // anthropics/claude-agent-sdk-typescript#352, still open. This version has no
  // opt-out — no `preserveBackgroundTasks`, no `interruptForeground`, and
  // `query.backgroundTasks()` is measured NOT to shield a task. Detached
  // `run_in_background` shells survive only by being separate OS processes.
  //
  // So the backstop below is necessary but not sufficient: it stops US from
  // severing background work, while the interrupt itself may already have.
  // Nothing ships a `background: true` agent today, so this is latent — but
  // anyone adding one should re-measure before relying on cancel semantics.
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
    // Graceful close of every thread (signals the generator to return
    // and aborts the thread controller) so their `claude` children are reaped
    // too. Sessions persist to disk, so nothing is lost.
    for (const [, rec] of this.activeThreads) this.#teardownThread(rec, 'shutdown')
    // Give in-flight chats a moment to flush their CANCELLED notifications and
    // let the SDK reap the CLI child before we exit.
    setTimeout(() => process.exit(0), 250)
  }
}

// A generous interrupt window before the backstop tears the thread down. A
// premature teardown here kills the whole thread (and any in-flight background
// tasks), so we only escalate when the stream is genuinely wedged, not merely
// slow to settle.
/** Whether a thread still has background work that must outlive the current
 * turn. One signal, replaced wholesale by `background_tasks_changed`. */
export function backgroundInFlight(rec) {
  return rec.backgroundTaskIds.size > 0
}

/** Whether a thread may NOT be idle-reaped or LRU-evicted.
 *
 * Exported, and the class methods delegate here, so a test can CALL this
 * instead of restating it. That is not tidiness: `verify-background-classification`
 * previously hand-copied this expression, dropped two of the three signals it
 * then had, and passed green against a thread the product still considered
 * busy — the regression it was written to catch. A predicate that decides
 * whether a subprocess lives or dies needs exactly one definition.
 *
 * Three signals: a turn is generating (`turnActive`), a turn is queued but not
 * yet picked up (`turnQueue.length` — the settle→re-park window where
 * `#settleTurn` has cleared turnActive but `#threadInput` hasn't shifted the
 * next item), or background work is live. Missing the queued-turn signal is the
 * turn-loss race: an evict in that window tears the thread down and the queued
 * turn vanishes with no terminal for its runId. */
export function threadBusy(rec) {
  return rec.turnActive || rec.turnQueue.length > 0 || backgroundInFlight(rec)
}

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
export const MAX_LIVE_THREADS = 6

// Persistent path: max wall-clock gap between events WITHIN an active turn
// before we treat the turn as network-wedged and hard-close the thread (it
// resumes from disk next turn). 180s — snappier than the SDK's 10-min
// backstop, above realistic model pauses. Only
// armed while a turn is generating; an idle-but-alive thread never times out.
const TURN_IDLE_MS = 180_000

