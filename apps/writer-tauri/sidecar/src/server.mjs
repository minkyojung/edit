import { readFile, readdir } from 'node:fs/promises'
import { join, normalize, relative, isAbsolute, resolve as resolvePath } from 'node:path'
import { tmpdir } from 'node:os'
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


/** Resolve a model-supplied file_path (absolute OR vault-relative) to an absolute
 * path inside the vault, or null if it escapes the vault. */
function resolveVaultFile(vaultPath, filePath) {
  const raw = String(filePath ?? '').trim()
  if (!raw) return null
  const rel = isAbsolute(raw) ? relative(vaultPath, raw) : normalize(raw)
  if (!rel || rel.startsWith('..') || rel.includes('/../')) return null
  return resolvePath(vaultPath, rel)
}

/** Validate a propose_edit `old_string` against the live file — the built-in Edit
 * tool's contract: it must match VERBATIM and UNIQUELY. Returns an error string for
 * the model (so it re-reads and retries with exact text) or null on success. Without
 * a vaultPath we can't read the file, so we let the edit through (host still checks). */
async function checkOldString(vaultPath, filePath, oldString) {
  if (!vaultPath) return null
  if (!oldString) return `(error: old_string is empty — provide the exact text to replace.)`
  // FAIL-OPEN on anything we can't verify (odd/symlinked path, unreadable file): don't
  // block a possibly-valid edit — the host still applies it. Only reject when we have
  // the file in hand AND the text genuinely isn't there.
  const abs = resolveVaultFile(vaultPath, filePath)
  if (!abs) return null
  let body
  try {
    body = await readFile(abs, 'utf-8')
  } catch {
    return null
  }
  const first = body.indexOf(oldString)
  if (first < 0) {
    return `(error: old_string was not found in ${filePath}. Read the file to get the current content and copy old_string VERBATIM, then retry.)`
  }
  if (body.indexOf(oldString, first + 1) >= 0) {
    return `(error: old_string matches more than one place in ${filePath}. Include enough surrounding lines to make it unique, then retry.)`
  }
  return null
}

// Relay tools: defined here, but every invocation reports back to the host
// (frontend) via a notification rather than performing the action itself.
// The frontend (which owns the editor / UI) does the real work.

// `edit_document` was the host-bridged Phase 2 / 3.C tool: the model
// emitted (quote, content, rationale) and the host's editListener →
// applyDirectEdit did the actual string splice. It has been replaced
// by Claude's built-in `Edit` tool (Phase 1.1) and is now removed —
// see the `canUseTool` hook below for the staged-edit gate that
// supersedes the old chat:edit bridge.

// Ingest result tool. Called once per ingest pass with the complete
// JSON shape the frontend used to extract from raw assistant text.
// The schema enforces structure at the SDK boundary — no more
// frontend-side JSON parsing or per-field sanitization.
//
// Single-call contract: the model emits exactly one tool call per
// run carrying every proposal / index update / log entry it decided
// on. Empty arrays + null logEntry are valid (an ingest pass that
// found nothing notable still calls the tool to mark the pass as
// complete). The handler forwards the raw input to the host as an
// `ingest/result` notification; ingest.ts assembles its IngestResult
// from that payload directly.
// `submit_profile` is the Profile-bootstrap counterpart to
// submit_ingest_result. The Profile pipeline runs N per-URL Haiku
// calls + 1 synthesis Sonnet call; every call uses this same tool
// to emit a Profile-shaped payload, so the schema is shared. The
// host distinguishes pass type by which event the run belongs to,
// not by tool name.
//
// All array fields are optional / can be empty — a per-URL pass
// may legitimately yield zero voice_samples for a thin source,
// and the synthesis pass merges across sources to fill gaps.
function buildSubmitProfileTool(runId, emit) {
  return tool(
    'submit_profile',
    'Submit a structured profile extracted from one or more sources about the user. Use null for fields you cannot determine; use empty arrays for list fields with no entries. voice_samples must be verbatim quotes from the source text — do not paraphrase or invent. dispositions and values may be inferred from the writing but should be supported by something in the source. Call this exactly once per run.',
    {
      name: z.string().nullable(),
      headline: z.string().nullable(),
      location: z.string().nullable(),
      roles: z.array(z.string()),
      interests: z.array(z.string()),
      voice_samples: z.array(z.string()),
      values: z.array(z.string()),
      dispositions: z.array(z.string()),
      about: z.string(),
    },
    async (args) => {
      emit(notification('profile/result', { runId, input: args }))
      return { content: [{ type: 'text', text: 'Profile result recorded.' }] }
    },
  )
}

// E6 "host-applies" pattern: instead of letting the SDK's built-in
// Edit / Write / MultiEdit tools touch disk themselves (gated through
// `canUseTool` and then resolved by user via the host), we register
// custom MCP tools with matching schemas that just FORWARD the
// proposal to the host as a `chat/edit-pending` notification and
// return success immediately. The model believes the edit succeeded;
// the host queues the proposal in `pendingChangesStore` and applies
// it on user Keep. Symmetry with ingest's `submit_ingest_result`
// (host does the writes after the LLM emits proposals).
//
// Why this is the right shape:
//   * Disk write timing is fully under host control — no IPC roundtrip
//     on Keep, no SDK gate-resolve dance, no echo-suppression hacks.
//   * Single store (`pendingChangesStore`) is the truth for both
//     chat AND ingest proposals.
//   * Failures localised: anything that goes wrong happens inside the
//     host's `appendMarkdownToWikiPage` / `applyReplaceInWikiPage`,
//     which we can debug + retry directly.
//
// Each tool's description deliberately echoes the built-in Claude
// Code semantics ("edits a file at path X by replacing old_string with
// new_string"). The model has prior experience with those names — the
// `propose_` prefix is the only visible difference, and the matching
// input shape keeps the tool-call ergonomics unchanged.
function buildProposeEditTool(runId, emit, vaultPath) {
  return tool(
    'propose_edit',
    'PREFERRED tool for changing an existing file. Propose a surgical edit: provide the absolute file_path, the exact old_string to replace (copy it VERBATIM from the file — Read it first if unsure), and the new_string. old_string MUST identify exactly ONE place in the file — if the text appears more than once, include enough surrounding lines to make it unique, otherwise the edit is rejected as ambiguous (the host never guesses which occurrence you meant). Works exactly like the built-in Edit tool. The host locates old_string and applies the change in place, then queues it for user review. Returns immediately — do not wait for the user.',
    {
      file_path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
    },
    async (input) => {
      // Validate the anchor against the live file (the built-in Edit's contract) so a
      // bad old_string is fixed by the model NOW instead of surfacing as a broken
      // proposal at Keep time.
      const err = await checkOldString(vaultPath, input.file_path, input.old_string)
      if (err) return { content: [{ type: 'text', text: err }] }
      const pendingId = globalThis.crypto.randomUUID()
      emit(
        notification('chat/edit-pending', {
          runId,
          pendingId,
          toolName: 'Edit',
          input,
        }),
      )
      return {
        content: [
          {
            type: 'text',
            text: `Edit queued for user review (id: ${pendingId}).`,
          },
        ],
      }
    },
  )
}

function buildProposeWriteTool(runId, emit) {
  return tool(
    'propose_write',
    'Create a BRAND-NEW file, or replace an existing file\'s ENTIRE content when the user explicitly asks for a full rewrite. Send `content` = the complete desired file content. For any partial change to an existing file — a single line, a value, appending a bullet — do NOT use this; use propose_edit instead so the change applies surgically in place. Returns immediately — do not wait for the user.',
    {
      file_path: z.string(),
      content: z.string(),
    },
    async (input) => {
      const pendingId = globalThis.crypto.randomUUID()
      emit(
        notification('chat/edit-pending', {
          runId,
          pendingId,
          toolName: 'Write',
          input,
        }),
      )
      return {
        content: [
          {
            type: 'text',
            text: `Write queued for user review (id: ${pendingId}).`,
          },
        ],
      }
    },
  )
}

// Propose saving a reusable procedure as a vault-local Agent Skill. Unlike
// propose_write (which targets wiki pages), this routes to the host's skill
// path, which on approval writes `_system/agent/skills/<name>/SKILL.md` —
// discovered + loaded on the next session via the plugins path. Decoupled
// from the doc-edit pipeline because a skill is agent infrastructure, not a
// wiki document.
function buildProposeSkillTool(runId, emit, existingSkills = []) {
  // Show the model the current skill library so it can decide UPDATE vs NEW
  // (the canonical extract→retrieve→decide pattern: the existing skills ARE
  // the retrieved candidates). NOOP is handled by instruction — "don't call
  // this tool at all" — so there's no NOOP field.
  const library = existingSkills.length
    ? existingSkills.map((s) => `- ${s.name}: ${s.description}`).join('\n')
    : '(none yet)'
  const description =
    'Propose saving a REUSABLE procedure as a skill the user approves. Use ONLY when you notice a way of working worth applying again next time — a multi-step procedure you just performed, or a correction to how you should work. Do NOT use for one-off tasks, simple answers, or facts (those are memory, not skills); when unsure, lean toward NOT proposing.\n\n' +
    'BEFORE proposing, check this list of skills that already exist:\n' +
    `${library}\n\n` +
    'Then choose ONE:\n' +
    '- NOOP: if an existing skill already covers this, do NOT call this tool at all.\n' +
    '- UPDATE: if this refines, corrects, or extends an existing skill, set `updates` to that skill\'s EXACT name, reuse that same `name`, and put the FULL revised procedure in `body` (it replaces the old one — do not send only the delta).\n' +
    '- NEW: only for a genuinely new procedure. Pick a fresh kebab-case `name` that does NOT collide with an existing one, and omit `updates`.\n\n' +
    'Fields: `name` (short kebab-case id), `description` (WHEN to use this skill — this is how it gets matched on future turns, so name the triggering situation specifically), `body` (the procedure as markdown), and optional `updates` (the exact name of the skill being revised). Returns immediately — do not wait for the user.'
  return tool(
    'propose_skill',
    description,
    {
      name: z.string(),
      description: z.string(),
      body: z.string(),
      updates: z.string().optional(),
    },
    async (input) => {
      const pendingId = globalThis.crypto.randomUUID()
      emit(
        notification('chat/skill-pending', {
          runId,
          pendingId,
          name: input.name,
          description: input.description,
          body: input.body,
          // Present only when the model is revising an existing skill. The
          // host uses it to render "update" vs "new" and to write in place.
          updates: input.updates ?? null,
        }),
      )
      return {
        content: [
          {
            type: 'text',
            text: `Skill "${input.name}" proposed for user review (id: ${pendingId}). Continue — do not wait.`,
          },
        ],
      }
    },
  )
}

function buildProposeMultiEditTool(runId, emit, vaultPath) {
  return tool(
    'propose_multi_edit',
    'Propose multiple edits to a single file in one transaction. The host queues this proposal for user review and applies it on approval. Use the same way as the built-in MultiEdit tool: provide the file_path and an array of edits, each with old_string and new_string. Each old_string MUST identify exactly ONE place in the file — when the same text appears more than once (e.g. two identical lines you want changed differently), include enough surrounding lines in each old_string to make it unique, otherwise that edit is rejected as ambiguous (the host never guesses which occurrence you meant). Returns immediately — do not wait for the user.',
    {
      file_path: z.string(),
      edits: z.array(
        z.object({
          old_string: z.string(),
          new_string: z.string(),
          replace_all: z.boolean().optional(),
        }),
      ),
    },
    async (input) => {
      // Validate every anchor before queuing — one bad old_string fails the whole
      // transaction (same as the built-in MultiEdit) so the model fixes it now.
      for (let i = 0; i < input.edits.length; i++) {
        const err = await checkOldString(vaultPath, input.file_path, input.edits[i].old_string)
        if (err) return { content: [{ type: 'text', text: `(edit #${i + 1}) ${err}` }] }
      }
      const pendingId = globalThis.crypto.randomUUID()
      emit(
        notification('chat/edit-pending', {
          runId,
          pendingId,
          toolName: 'MultiEdit',
          input,
        }),
      )
      return {
        content: [
          {
            type: 'text',
            text: `MultiEdit queued for user review (id: ${pendingId}).`,
          },
        ],
      }
    },
  )
}

// Recursive VizNode schema — mirrors src/viz/vizSpec.ts. Layout nodes
// (stack/columns) nest children; leaves are charts + stat/text/table. The model
// fills this when it calls edit_visualization, so its output is shaped to our
// component tree (no HTML/colors). The frontend re-validates via parseVizSpec.
const VIZ_GAP = z.enum(['sm', 'md', 'lg'])
const VIZ_DATUM = z.object({ label: z.string(), value: z.number() })
const VIZ_SERIES = z.object({ label: z.string(), values: z.array(z.number()) })
const vizNodeSchema = z.lazy(() =>
  z.union([
    z.object({ type: z.literal('stack'), gap: VIZ_GAP.optional(), children: z.array(vizNodeSchema).min(1) }),
    z.object({ type: z.literal('columns'), gap: VIZ_GAP.optional(), children: z.array(vizNodeSchema).min(1) }),
    z.object({ type: z.literal('donut'), title: z.string().optional(), data: z.array(VIZ_DATUM).min(1) }),
    z.object({ type: z.literal('bar'), title: z.string().optional(), data: z.array(VIZ_DATUM).min(1) }),
    z.object({
      type: z.literal('column'),
      title: z.string().optional(),
      xLabels: z.array(z.string()).min(1),
      series: z.array(VIZ_SERIES).min(1),
      stacked: z.boolean().optional(),
    }),
    z.object({
      type: z.literal('kpi'),
      title: z.string().optional(),
      items: z.array(z.object({ label: z.string(), value: z.string(), sub: z.string().optional() })).min(1),
    }),
    z.object({ type: z.literal('stat'), label: z.string(), value: z.string(), sub: z.string().optional() }),
    z.object({ type: z.literal('text'), value: z.string(), variant: z.enum(['title', 'body', 'muted']).optional() }),
    z.object({
      type: z.literal('table'),
      columns: z.array(z.string()).min(1),
      rows: z.array(z.array(z.union([z.string(), z.number()]))).min(1),
    }),
  ]),
)

// edit_visualization: change a chart already in the document, addressed by its
// stable id. Like the propose_* tools the handler just forwards to the host (the
// editor work — find the block by id, replace its spec — happens in the
// frontend) and acks so the model continues in the same turn. Unlike propose_*
// it applies immediately (no Keep/Reject); the user undoes with Cmd+Z.
function buildEditVisualizationTool(runId, emit) {
  return tool(
    'edit_visualization',
    'Edit a data visualization that is ALREADY in the document, addressed by its chartId. Pass the FULL updated tree as `root`. A node is a layout — {type:"stack"|"columns", gap?, children:[…]} — or a leaf: {type:"donut"|"bar", title?, data:[{label,value}]} / {type:"column", title?, xLabels:[…], series:[{label,values:[…]}]} / {type:"kpi", title?, items:[{label,value,sub?}]} / {type:"stat", label, value, sub?} / {type:"text", value, variant?} / {type:"table", columns:[…], rows:[[…]]}. DATA + STRUCTURE ONLY — never colors, sizes, or fonts; the app owns the look. Preserve any data you were not asked to change. The host applies it in place. Returns immediately — do not wait.',
    {
      chartId: z.string(),
      root: vizNodeSchema,
    },
    async (input) => {
      emit(
        notification('chat/viz-apply', {
          runId,
          chartId: input.chartId,
          root: input.root,
        }),
      )
      return {
        content: [{ type: 'text', text: `Visualization ${input.chartId} updated.` }],
      }
    },
  )
}

const SIDECAR_VERSION = '0.1.0'

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
    // runId -> AbortController
    this.activeChats = new Map()
    // decisionId -> { resolve, reject } for in-flight canUseTool gates
    // (plan approval / clarifying questions) awaiting a host decision.
    this.pendingDecisions = new Map()
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
        case 'chat/decision':
          return this.#handleDecision(params)
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

    // Token env is injected per-attempt inside #runChat so the AUTH-retry
    // path picks up rotated tokens automatically.

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

    // Acknowledge acceptance before we start streaming.
    this.emit(response(id, { runId, accepted: true }))

    this.#runChat(runId, params, controller).catch((err) => {
      logErrorContext('runChat-uncaught', runId, err, { mode: this.mode })
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
      vaultPath,
      permissionMode = 'bypassPermissions',
      effort,
      fastMode,
      sessionId,
      resume,
      maxTurns,
      builtinTools,
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
      // Auto-summarize older turns once context approaches the model
      // limit, instead of erroring out. autoCompactEnabled lives in
      // Settings (sdk.d.ts:5073) — surfaced via the `settings` flag
      // layer, which has higher precedence than user settings.json.
      // The cacheable system-prompt prefix (belief + role) is preserved
      // across compaction; only mid-conversation turns get summarized.
      // fastMode (faster output on supporting models) is a `Settings` member,
      // same layer as autoCompactEnabled. Only set when requested; the host
      // already gated on model support.
      settings: { autoCompactEnabled: true, ...(fastMode ? { fastMode: true } : {}) },
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
          if (filePath.startsWith(PLAN_MODE_PLANS_DIR)) {
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

    // Phase 1 of the Claude-Code-style migration: when the host gives us
    // a vaultPath, root the agent in the vault and turn on Claude Code's
    // full built-in toolset (Read/Edit/Write/Bash/Grep/Glob/...). The
    // model can now read and edit vault .md files directly through the
    // tools it already knows from Claude Code — no custom edit relay
    // required. We keep the legacy `edit_document` MCP tool registered
    // alongside so a regression in built-in routing falls back instead
    // of breaking chat. Once the built-in path is verified end-to-end
    // (Phase 2) the legacy tool and applyDirectEdit host bridge come out.
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
      // Built-in tool exposure is per-caller. Chat needs the full
      // Claude Code preset (Read / Edit / Write / Bash / Grep / Glob)
      // so the model can edit the doc on user request, gated through
      // `canUseTool` + the host's PendingEditsBar. Ingest is a
      // background flow with a structured-output channel — the LLM
      // must not write to disk directly, so the host pins it to a
      // read-only subset (Read / Glob / Grep, typically). Output
      // lands via the `submit_ingest_result` relay tool and the host
      // turns proposals into disk writes after user review.
      //
      // `tools: ['Read', ...]` (explicit array) is the SDK's "least
      // privilege" surface (sdk.d.ts:1211) — listed tools are the
      // only ones the model sees, so Edit/Write are not just denied
      // but invisible. Caller omits `builtinTools` for the chat
      // shape and the preset stays.
      options.tools = Array.isArray(builtinTools) && builtinTools.length > 0
        ? builtinTools
        : { type: 'preset', preset: 'claude_code' }
      // Phase 3.1 of the Cursor-style staged edit migration: every
      // built-in write-side tool (Edit / Write / MultiEdit / NotebookEdit)
      // routes through `canUseTool` before it can run. For now we deny
      // them all and surface the attempt so we can verify on the host
      // that no fs.write slipped through — the next sub-phase (3.2)
      // replaces this with a host round-trip that waits for the user
      // to Apply/Reject. Read / Grep / Glob / Bash are not gated; the
      // model still needs them to discover context.
      //
      // `permissionMode` MUST drop out of `bypassPermissions` for
      // `canUseTool` to fire — bypass mode short-circuits the
      // permission check entirely (sdk.d.ts L1806). 'default' is the
      // standard mode where the SDK consults `canUseTool` (or, absent
      // a callback, falls back to its interactive CLI prompt — which
      // doesn't apply to us since we're driving the SDK from a long-
      // running sidecar).
      // Phase E6: the chat surface no longer exposes write-side
      // built-in tools (Edit / Write / MultiEdit / NotebookEdit are
      // omitted from `builtinTools` by the host). Disk-changing
      // intent now flows through the host-applies `propose_*` MCP
      // tools (registered in the relay loop below), which emit a
      // `chat/edit-pending` notification and return immediately
      // without parking a Promise. The host queues the proposal in
      // `pendingChangesStore` and applies it on user Keep.
      //
      // permissionMode stays 'bypassPermissions' (its default) so
      // the SDK auto-runs the remaining read-side tools without a
      // CLI prompt. No `canUseTool` callback needed.

      // Vault-local Agent Skills (procedural memory). Load the vault's
      // skill plugin (`_system/agent`) and enable only its skills by name.
      // We pass an explicit allowlist (the discovered skill dir names), NOT
      // `'all'` — `'all'` would also pull Claude Code's bundled skills
      // (loop / schedule / ...) into context. `settingSources` stays `[]`,
      // so skills arrive via the plugin path alone and our injected
      // CLAUDE.md / cache discipline is untouched. Progressive disclosure:
      // only each skill's name+description sits in context until the model
      // activates one. Additive + backward-compatible: no skills dir → the
      // `readdir` throws, we swallow it, and nothing about the call changes.
      try {
        const skillsRoot = join(vaultPath, '_system/agent/skills')
        const skillNames = (await readdir(skillsRoot, { withFileTypes: true }))
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
        if (skillNames.length > 0) {
          options.plugins = [{ type: 'local', path: join(vaultPath, '_system/agent') }]
          options.skills = skillNames
          // The `Skill` tool must be exposed for skills to load + activate.
          // When `options.tools` is an explicit allowlist — which the chat
          // shape is (host passes builtinTools = ['Read','Glob','Grep','Bash'])
          // — 'Skill' isn't in it, so skills silently never load (no Skills
          // category, model can't invoke them). Add it. The preset shape
          // ({type:'preset',...}) already includes Skill, so only the array
          // case needs patching.
          if (Array.isArray(options.tools) && !options.tools.includes('Skill')) {
            options.tools = [...options.tools, 'Skill']
          }
          // Read each SKILL.md's frontmatter name + description so
          // propose_skill can present the existing library to the model for
          // its UPDATE/NEW decision. A skill folder without a readable
          // SKILL.md is just skipped (it still loads via the plugin path).
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
        // No `_system/agent/skills` directory (or unreadable) → no skills,
        // no change to the SDK call.
      }
    }

    // Wire relay tools: each one runs inside this sidecar but its handler
    // just forwards args to the host as a `chat/proposal`-shaped event and
    // returns a brief ack so the model can continue. The actual editor /
    // UI work happens in the frontend.
    const enabledRelay = Array.isArray(relayTools)
      ? relayTools
      : (this.mode === 'chat' ? [] : [])
    const relayDefs = []
    for (const name of enabledRelay) {
      if (name === 'submit_profile') {
        relayDefs.push(buildSubmitProfileTool(runId, this.emit))
      } else if (name === 'propose_edit') {
        relayDefs.push(buildProposeEditTool(runId, this.emit, vaultPath))
      } else if (name === 'propose_write') {
        relayDefs.push(buildProposeWriteTool(runId, this.emit))
      } else if (name === 'propose_skill') {
        relayDefs.push(buildProposeSkillTool(runId, this.emit, existingSkills))
      } else if (name === 'propose_multi_edit') {
        relayDefs.push(buildProposeMultiEditTool(runId, this.emit, vaultPath))
      } else if (name === 'edit_visualization') {
        relayDefs.push(buildEditVisualizationTool(runId, this.emit))
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
            lastRateLimitInfo = event.rate_limit_info
            if (event.rate_limit_info.status === 'rejected') {
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

  #emitChatError(runId, code, message, retryable, rateLimit) {
    this.emit(
      notification('chat/error', { runId, code, message, retryable, rateLimit }),
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

  #handleCancel(params) {
    const runId = params?.runId
    if (typeof runId !== 'string') return
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

  async #handleShutdown(id) {
    this.shuttingDown = true
    for (const [, rec] of this.activeChats) rec.controller.abort()
    if (id !== undefined) this.emit(response(id, null))
    // Give in-flight chats a moment to flush their CANCELLED notifications.
    setTimeout(() => process.exit(0), 250)
  }
}

// How long a graceful interrupt() gets to settle the run before the cancel
// handler forces a hard abort. Short enough to feel instant, long enough for
// the model to reach a safe boundary.
const INTERRUPT_GRACE_MS = 1500

// Codes the user can't fix by retrying the same request. Used to set the
// `retryable` flag (host hides the Retry button for these).
const NON_RETRYABLE_CODES = new Set(['AUTH', 'INVALID', 'BILLING', 'BUDGET'])

// Shape the SDK's `rate_limit_info` into the compact reset payload the host
// attaches to a RATE_LIMIT error (resetsAt drives the countdown / date;
// rateLimitType + overageDisabledReason pick the distinct copy). Returns
// undefined when there's nothing to carry so the field is simply absent.
function rateLimitPayload(info) {
  if (!info) return undefined
  return {
    resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : undefined,
    rateLimitType: info.rateLimitType,
    overageDisabledReason: info.overageDisabledReason,
  }
}

// Map a structured SDK error — the result `subtype` and/or the mid-turn
// SDKAssistantMessageError — to a host error code, an English fallback
// message, and retryability. The host owns the final user-facing copy
// (humanizeError) for every code except EXEC, which forwards the SDK's own
// `errors[0]` detail. `assistantError` is more specific than a generic
// `error_during_execution` subtype, so it wins when both are present.
function mapSdkError({ subtype, assistantError, errors }) {
  switch (assistantError) {
    case 'authentication_failed':
      return { code: 'AUTH', message: 'authentication failed', retryable: false }
    case 'rate_limit':
      return { code: 'RATE_LIMIT', message: 'rate limited', retryable: true }
    case 'billing_error':
      return { code: 'BILLING', message: 'credit balance too low', retryable: false }
    case 'server_error':
      return { code: 'SERVER', message: 'service is busy', retryable: true }
    case 'invalid_request':
      return { code: 'INVALID', message: 'invalid request', retryable: false }
    case 'max_output_tokens':
      return { code: 'TRUNCATED', message: 'response was cut off', retryable: true }
    default:
      break
  }
  switch (subtype) {
    case 'error_max_turns':
      return { code: 'MAX_TURNS', message: 'stopped after too many tool steps', retryable: true }
    case 'error_max_budget_usd':
      return { code: 'BUDGET', message: 'hit the cost limit', retryable: false }
    case 'error_max_structured_output_retries':
      return { code: 'FORMAT', message: 'could not produce a valid result format', retryable: true }
    case 'error_during_execution':
    default: {
      // Forward the SDK's own `errors[0]` detail (may be empty); the host
      // composes the final "Stopped on an error[: detail]" copy.
      const detail = Array.isArray(errors) && errors.length > 0 ? String(errors[0]) : ''
      return { code: 'EXEC', message: detail, retryable: true }
    }
  }
}

function classifyError(err) {
  // Prefer a structured HTTP status when the thrown error carries one
  // (Anthropic SDK errors expose `.status`); fall back to message regex.
  const status = typeof err?.status === 'number' ? err.status : undefined
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return 'INVALID'
  if (status === 500 || status === 529) return 'SERVER'
  const msg = err?.message ? String(err.message) : String(err)
  if (/401|unauthor|invalid[_ ]?token/i.test(msg)) return 'AUTH'
  if (/429|rate[_ ]?limit/i.test(msg)) return 'RATE_LIMIT'
  if (/ETIMEDOUT|timed[_ ]?out/i.test(msg)) return 'IDLE_TIMEOUT'
  if (/network|fetch failed|ECONN/i.test(msg)) return 'NETWORK'
  return 'INTERNAL'
}
