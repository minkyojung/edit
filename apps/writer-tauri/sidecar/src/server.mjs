import { readFile, readdir } from 'node:fs/promises'
import { normalize, resolve as resolvePath } from 'node:path'
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

/** Subfolders the LLM is allowed to read via `read_page` / `search_wiki`.
 * Excludes `daily/` and `threads/` — those are user-authored sources, not
 * wiki content the LLM should be looking up. Excludes nothing inside
 * `_system/` either, since system pages (conventions / log / index) are
 * legitimate context for the LLM's routing decisions. */
const READABLE_PREFIXES = ['wiki/', '_system/']

/** Validate a vault-relative path the model passed in. Returns the
 * normalised relative path on success or null when the path would
 * escape the allowed subfolders. We don't trust the model not to try
 * `../etc/passwd`; the gate here is the only safety net before we
 * hand the path to `readFile`. */
function validateVaultRelPath(rawPath) {
  const trimmed = String(rawPath ?? '').trim()
  if (!trimmed) return null
  // Reject absolute paths and any segment that climbs out.
  if (trimmed.startsWith('/') || trimmed.includes('\\')) return null
  const normalised = normalize(trimmed)
  if (normalised.startsWith('..') || normalised.includes('/../')) return null
  if (!READABLE_PREFIXES.some((p) => normalised.startsWith(p))) return null
  return normalised
}

// Relay tools: defined here, but every invocation reports back to the host
// (frontend) via a notification rather than performing the action itself.
// The frontend (which owns the editor / UI) does the real work.

// `read_page` is the Karpathy-style "structured discovery" primitive —
// the model reads the Tier 1 catalog (shipped in the system prompt),
// picks the page it wants in full, and calls this tool with the path.
// Unlike the relay tools above, the handler IS the data source: it
// reads markdown from the user's vault directly. No frontend round-
// trip. This is the standard Claude SDK pattern — async tool
// handlers return content the model continues with on the next turn.
//
// Security: the path must be vault-relative under `wiki/` or `_system/`.
// Anything else (absolute paths, `..`, daily notes) is rejected with
// an error string so the model can route differently.
function buildReadPageTool(vaultPath) {
  return tool(
    'read_page',
    'Read the full markdown body of a wiki or system page from the user\'s vault. Pass a vault-relative path beginning with "wiki/" or "_system/" (e.g., "wiki/Sarah Kim.md"). The catalog in the system prompt lists every page\'s path. Use this when the catalog alone is not enough and you need the page in full to answer or to verify a claim.',
    { path: z.string() },
    async (args) => {
      const rel = validateVaultRelPath(args.path)
      if (!rel) {
        return {
          content: [
            {
              type: 'text',
              text: `(error: path "${args.path}" is not readable — must be vault-relative under wiki/ or _system/)`,
            },
          ],
        }
      }
      try {
        const abs = resolvePath(vaultPath, rel)
        const body = await readFile(abs, 'utf-8')
        return { content: [{ type: 'text', text: body }] }
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `(error reading ${rel}: ${err?.message ?? err})` },
          ],
        }
      }
    },
  )
}

// `search_wiki` is the "find pages by content" companion to read_page.
// The model passes a substring query; we scan every .md in wiki/ and
// return the paths whose title or body contains the query (case-
// insensitive). Title matches rank first because they're a stronger
// signal of "this page is about X".
//
// Result format: a markdown list of `- path — excerpt` lines so the
// model has both the path (to feed back into read_page) and a hint
// of why this file matched. Excerpt is the first body line that
// contains the query, trimmed to ~80 chars.
//
// Cap at 20 results — the catalog (Tier 1) already gave the LLM the
// full surface area; this tool is for "find anything mentioning X",
// not for paginating the wiki. If the model needs more it can
// narrow the query.
const SEARCH_RESULT_CAP = 20
const SEARCH_EXCERPT_MAX = 80

function buildSearchWikiTool(vaultPath) {
  return tool(
    'search_wiki',
    'Find wiki pages whose title or body contains a substring. Pass `query` (case-insensitive). Returns up to 20 results as `- path — excerpt` lines, ranked title-match first then body-match. Use this when the catalog\'s one-line summaries are not enough to decide which page is relevant; then call read_page on a result to read the page in full.',
    { query: z.string() },
    async (args) => {
      const q = String(args.query ?? '').trim().toLowerCase()
      if (!q) {
        return { content: [{ type: 'text', text: '(error: empty query)' }] }
      }
      const wikiDir = resolvePath(vaultPath, 'wiki')
      let entries
      try {
        entries = await readdir(wikiDir, { withFileTypes: true })
      } catch (err) {
        return {
          content: [{ type: 'text', text: `(error reading wiki/: ${err?.message ?? err})` }],
        }
      }
      const titleHits = []
      const bodyHits = []
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue
        // Skip sidecars (.meta.json) — readdir already filters by .md but
        // belt-and-braces in case future suffixes leak in.
        if (entry.name.endsWith('.meta.json') || entry.name.endsWith('.ydoc')) continue
        const filename = entry.name
        const titleHit = filename.toLowerCase().includes(q)
        let body = ''
        try {
          body = await readFile(resolvePath(wikiDir, filename), 'utf-8')
        } catch {
          continue // unreadable file, skip silently
        }
        const lower = body.toLowerCase()
        const bodyIdx = lower.indexOf(q)
        if (!titleHit && bodyIdx < 0) continue
        // Build excerpt: first non-empty line that contains the query,
        // or the first line of the body when only title matched.
        let excerpt = ''
        if (bodyIdx >= 0) {
          const lines = body.split('\n')
          for (const line of lines) {
            if (line.toLowerCase().includes(q) && line.trim().length > 0) {
              excerpt = line.trim()
              break
            }
          }
        }
        if (!excerpt) {
          for (const line of body.split('\n')) {
            if (line.trim().length > 0) {
              excerpt = line.trim()
              break
            }
          }
        }
        if (excerpt.length > SEARCH_EXCERPT_MAX) {
          excerpt = excerpt.slice(0, SEARCH_EXCERPT_MAX).trimEnd() + '…'
        }
        const entryLine = `- wiki/${filename} — ${excerpt || '(empty)'}`
        if (titleHit) titleHits.push(entryLine)
        else bodyHits.push(entryLine)
      }
      const all = [...titleHits.sort(), ...bodyHits.sort()].slice(
        0,
        SEARCH_RESULT_CAP,
      )
      if (all.length === 0) {
        return {
          content: [{ type: 'text', text: `(no wiki pages match "${args.query}")` }],
        }
      }
      const truncated =
        titleHits.length + bodyHits.length > SEARCH_RESULT_CAP
          ? `\n\n(showing first ${SEARCH_RESULT_CAP} of ${titleHits.length + bodyHits.length} matches; narrow the query for more.)`
          : ''
      return {
        content: [{ type: 'text', text: all.join('\n') + truncated }],
      }
    },
  )
}

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

function buildSubmitIngestResultTool(runId, emit) {
  return tool(
    'submit_ingest_result',
    'Submit the structured result of an ingest pass over a user note. Call this exactly once per run, after analyzing the note against the wiki. Include every proposal, index update, and log entry; if you found nothing, pass empty arrays and a null logEntry.',
    {
      proposals: z.array(
        z.object({
          target: z.string().optional(),
          suggestNewPage: z.string().optional(),
          suggestNewPageParent: z.string().optional(),
          // Phase G: free-form markdown the host appends as-is. The
          // LLM follows the vault-root CLAUDE.md formatting rules
          // (no duplicate page-title heading, `[[Page]]` for wiki
          // refs, `> "..."` for source citation, etc.) so the host
          // no longer wraps the output. `sourceQuote` stays as the
          // dedup + provenance handle.
          markdownToAppend: z.string().min(1),
          rationale: z.string().optional(),
          sourceQuote: z.string().optional(),
        }),
      ),
      indexUpdates: z.array(
        z.object({
          target: z.string(),
          summary: z.string(),
        }),
      ),
      logEntry: z.string().nullable(),
    },
    async (args) => {
      emit(notification('ingest/result', { runId, input: args }))
      return { content: [{ type: 'text', text: 'Ingest result recorded.' }] }
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
function buildProposeEditTool(runId, emit) {
  return tool(
    'propose_edit',
    'PREFERRED tool for changing an existing file. Propose a surgical edit: provide the absolute file_path, the exact old_string to replace (copy it VERBATIM from the file — read_page first if unsure), and the new_string. Works exactly like the built-in Edit tool. The host locates old_string and applies the change in place, then queues it for user review. Returns immediately — do not wait for the user.',
    {
      file_path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
    },
    async (input) => {
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

function buildProposeMultiEditTool(runId, emit) {
  return tool(
    'propose_multi_edit',
    'Propose multiple edits to a single file in one transaction. The host queues this proposal for user review and applies it on approval. Use the same way as the built-in MultiEdit tool: provide the file_path and an array of edits, each with old_string and new_string. Returns immediately — do not wait for the user.',
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

const SIDECAR_VERSION = '0.1.0'

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
      sessionId,
      resume,
      maxTurns,
      builtinTools,
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
      if (name === 'submit_ingest_result') {
        relayDefs.push(buildSubmitIngestResultTool(runId, this.emit))
      } else if (name === 'submit_profile') {
        relayDefs.push(buildSubmitProfileTool(runId, this.emit))
      } else if (name === 'read_page') {
        if (!vaultPath) {
          console.warn(
            `[sidecar] read_page requested but vaultPath not provided; skipping (runId=${runId})`,
          )
          continue
        }
        relayDefs.push(buildReadPageTool(vaultPath))
      } else if (name === 'search_wiki') {
        if (!vaultPath) {
          console.warn(
            `[sidecar] search_wiki requested but vaultPath not provided; skipping (runId=${runId})`,
          )
          continue
        }
        relayDefs.push(buildSearchWikiTool(vaultPath))
      } else if (name === 'propose_edit') {
        relayDefs.push(buildProposeEditTool(runId, this.emit))
      } else if (name === 'propose_write') {
        relayDefs.push(buildProposeWriteTool(runId, this.emit))
      } else if (name === 'propose_multi_edit') {
        relayDefs.push(buildProposeMultiEditTool(runId, this.emit))
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
    // Aborting the run also unparks any canUseTool waiters keyed to
    // this run via the controller.signal listener installed inside
    // canUseTool — no explicit drain needed here.
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
