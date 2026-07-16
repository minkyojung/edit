import { readFile, readdir, access } from 'node:fs/promises'
import { join, normalize, relative, isAbsolute, resolve as resolvePath } from 'node:path'
import { tmpdir, homedir } from 'node:os'
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


// ── Security lockdown ────────────────────────────────────────────
//
// "Close the exits": the agent may edit files locally (that's the
// product), but two things must never be possible even if untrusted
// captured content (a web page / transcript) carries a prompt
// injection — (1) sending data OUT to the network, and (2) reading
// the user's SECRETS. This is Anthropic's "containment of last
// resort": if credentials can't be reached and egress is blocked, a
// successful injection is harmless.
//
// Two overlapping layers, because they govern DIFFERENT surfaces (per the
// SDK, tool access is controlled by permission rules, while the sandbox
// confines subprocesses — sdk.d.ts: "Filesystem and network restrictions
// are configured via permission rules, not via these sandbox settings"):
//   • deny RULES (settings.permissions.deny) — evaluated BEFORE the
//     canUseTool gate (and win even under bypass). This is the ONLY thing
//     that stops the in-process file tools (`Read`, `Glob`) from reading
//     `~/.ssh/id_rsa`, and it hard-blocks the common network shells. It
//     also holds when the sandbox can't initialise. Zero dependency.
//   • OS SANDBOX (options.sandbox) — kernel-level (macOS Seatbelt),
//     confines the tool SUBPROCESSES (`Bash`, and `Grep`/ripgrep): blocks
//     their network egress and (via `filesystem.denyRead`) their reads of
//     the same secret paths — closing the shell leaks the deny rules
//     can't. `failIfUnavailable: false` so a sandbox that can't initialise
//     degrades to the permission-rule layer instead of breaking chat.

/** Home-relative secret locations the agent must never read or write.
 * `~`-relative so the same list feeds both the sandbox (absolute paths)
 * and the permission rules (SDK `~/…` grammar). */
const SECRET_HOME_RELATIVE = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gh',
  '.config/gcloud',
  '.kube',
  '.npmrc',
  // The app's own encrypted OAuth/token store.
  'Library/Application Support/com.minkyojung.octave',
]

/** Absolute secret locations for the OS sandbox's `filesystem.denyRead`.
 * That layer confines only the tool SUBPROCESSES (Bash, and Grep — which
 * shells out to ripgrep); it does NOT govern the in-process file tools. */
function secretPaths() {
  const home = homedir()
  return SECRET_HOME_RELATIVE.map((rel) => `${home}/${rel}`)
}

/** Permission deny rules for the secret locations. Per the Claude Code
 * docs, the built-in file tools use the PERMISSION system, not the sandbox
 * ("Read, Edit, and Write use the permission system directly rather than
 * running through the sandbox") — so the sandbox `denyRead` above does NOT
 * stop them; without these rules the `Read` tool reads `~/.ssh/id_rsa`
 * straight into context.
 *
 * `Read` + `Edit` are the two canonical rule families and cover the whole
 * surface: a `Read` deny is applied best-effort to every read tool (`Read`,
 * and `Grep`/`Glob`), and an `Edit` deny to every write tool (`Edit`,
 * `Write`, `MultiEdit`, `NotebookEdit`) — and both also catch the file
 * commands Claude Code recognises in Bash (`cat`/`head`/`sed`). Arbitrary
 * subprocess reads (a python script) are caught by the sandbox `denyRead`
 * instead. Rules follow the gitignore-style grammar: `~/`-relative, plus a
 * `/**` variant so both the directory and everything under it match. */
function secretDenyRules() {
  const rules = []
  for (const rel of SECRET_HOME_RELATIVE) {
    for (const tool of ['Read', 'Edit']) {
      rules.push(`${tool}(~/${rel})`)
      rules.push(`${tool}(~/${rel}/**)`)
    }
  }
  return rules
}

/** Deny rules that hard-block network-egress shells before any gate. */
function egressDenyRules() {
  return [
    'Bash(curl:*)',
    'Bash(wget:*)',
    'Bash(nc:*)',
    'Bash(ncat:*)',
    'Bash(telnet:*)',
    'Bash(scp:*)',
    'Bash(sftp:*)',
  ]
}

/** Deny the commands that dump the process environment, where the SDK-required
 * CLAUDE_CODE_OAUTH_TOKEN lives (the CLI must receive it via env; Bash children
 * inherit it). This is defense-in-depth, NOT a complete boundary: it stops the
 * literal `printenv CLAUDE_CODE_OAUTH_TOKEN` / `env` probe an injected note is
 * likely to use, but shell expansion (`echo $CLAUDE_CODE_OAUTH_TOKEN`) can't be
 * caught by a command-name rule. The real closure is the sandbox blocking
 * network egress (so a read token can't leave the machine) — see sandboxLockdown
 * / failIfUnavailable. `set`/`export` are intentionally omitted: prefix-denying
 * them would break legitimate `set -e` / `export FOO=…` usage for little gain. */
function envDumpDenyRules() {
  return ['Bash(printenv:*)', 'Bash(env:*)']
}

/** OS-sandbox config: block outbound network from tool subprocesses and
 * deny reads of the secret locations. */
function sandboxLockdown() {
  return {
    enabled: true,
    // failIfUnavailable:false → a host where the sandbox can't initialise
    // degrades to a warning instead of breaking chat. The Claude Code docs
    // recommend `true` for a hard security gate; deferred until the
    // packaged build confirms Seatbelt initialises there. Safe to defer:
    // the permission deny rules (secret + egress) are sandbox-INDEPENDENT
    // and still apply, and the only untrusted-content shape (intake) has no
    // Bash at all — the residual (arbitrary-subprocess reads/egress with the
    // sandbox down) is reachable only from the trusted, user-driven chat.
    failIfUnavailable: false,
    // Ignore the model's `dangerouslyDisableSandbox` escape hatch — a
    // sandboxed command that fails must NOT silently retry unsandboxed.
    // ("the dangerouslyDisableSandbox parameter is completely ignored and
    // all commands must run sandboxed" — Claude Code sandbox docs.)
    allowUnsandboxedCommands: false,
    // No allowed domains → tool subprocesses get no network egress (the
    // proxy pre-allows nothing, so every new host is blocked in headless).
    // The SDK↔model API channel and server-side WebSearch/WebFetch run
    // OUTSIDE this sandbox, so live web research still works.
    network: { allowedDomains: [] },
    // OS-level backstop for the SUBPROCESS reads the permission rules can't
    // reach (a python/node script opening a file itself). The tool-level
    // block lives in secretDenyRules().
    filesystem: { denyRead: secretPaths() },
  }
}

/** True if the SDK has persisted a session with this id to disk. The SDK writes
 * each session as `~/.claude/projects/<cwd-encoded>/<sessionId>.jsonl`; the
 * <cwd-encoded> segment mangles the path (slashes → dashes, and dotfiles too),
 * so rather than reproduce that encoding we scan the project dirs for the
 * `<sessionId>.jsonl` file — the id is a UUID, so a match is unambiguous.
 * Used by the AUTH-retry path to decide resume-vs-recreate: we only `resume`
 * a session that actually exists, so a first attempt that 401'd before any
 * session file was written falls back to a clean create instead of erroring on
 * a missing session. Best-effort: any fs error reads as "not persisted". */
async function sessionPersisted(sessionId) {
  if (!sessionId) return false
  const base = join(homedir(), '.claude', 'projects')
  let dirs
  try {
    dirs = await readdir(base)
  } catch {
    return false
  }
  for (const dir of dirs) {
    try {
      await access(join(base, dir, `${sessionId}.jsonl`))
      return true
    } catch {
      // Not in this project dir — keep looking.
    }
  }
  return false
}

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

/** Pull the pendingId a propose_edit/write/multi_edit call stamped into its
 * own success text ("... queued for user review (id: <uuid>)."), out of a
 * PostToolUse hook's `tool_response` — shape is `unknown` per the SDK types,
 * so stringify first rather than assume a specific object shape; the id
 * substring survives serialization regardless of how it's nested. Returns
 * null when no id is found (a call that errored before queuing, or an
 * unrelated tool). */
function extractPendingId(toolResponse) {
  let text
  try {
    text = typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse ?? '')
  } catch {
    return null
  }
  const match = /\(id:\s*([0-9a-f-]{36})\)/i.exec(text ?? '')
  return match ? match[1] : null
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

// E6 "host-applies" pattern: instead of letting the SDK's built-in
// Edit / Write / MultiEdit tools touch disk themselves (gated through
// `canUseTool` and then resolved by user via the host), we register
// custom MCP tools with matching schemas that just FORWARD the
// proposal to the host as a `chat/edit-pending` notification and
// return success immediately. The model believes the edit succeeded;
// the host queues the proposal in `pendingChangesStore` and applies
// it on user Keep. Ingest proposals flow the same way — the host does
// the writes after the LLM emits proposals.
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
function buildProposeEditTool(getRunId, emit, vaultPath, registerAck) {
  return tool(
    'propose_edit',
    'PREFERRED tool for changing an existing file. Propose a surgical edit: provide the absolute file_path, the exact old_string to replace (copy it VERBATIM from the file — Read it first if unsure), and the new_string. old_string MUST identify exactly ONE place in the file — if the text appears more than once, include enough surrounding lines to make it unique, otherwise the edit is rejected as ambiguous (the host never guesses which occurrence you meant). Works exactly like the built-in Edit tool. The host locates old_string and applies the change in place, then queues it for user review. Returns immediately — do not wait for the user. `reason`: a short one-line note recorded in the VERSION HISTORY (the commit log) for this edit — say what changed and why in plain terms. It is NOT shown in your chat reply; it is the audit trail so the user can later see why a change was made. Keep it specific ("Fixed the typo in the intro", "Added the 2026 pricing row"), not generic.',
    {
      file_path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
      reason: z.string().optional(),
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
          runId: getRunId(),
          pendingId,
          toolName: 'Edit',
          input,
        }),
      )
      registerAck(pendingId)
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

function buildProposeWriteTool(getRunId, emit, registerAck) {
  return tool(
    'propose_write',
    'Create a BRAND-NEW file, or replace an existing file\'s ENTIRE content when the user explicitly asks for a full rewrite. Send `content` = the complete desired file content. For any partial change to an existing file — a single line, a value, appending a bullet — do NOT use this; use propose_edit instead so the change applies surgically in place. Returns immediately — do not wait for the user. `reason`: a short one-line note recorded in the VERSION HISTORY (the commit log) for this write — say what the file is / why you created or rewrote it, in plain terms. It is NOT shown in your chat reply; it is the audit trail. Keep it specific, not generic.',
    {
      file_path: z.string(),
      content: z.string(),
      reason: z.string().optional(),
    },
    async (input) => {
      const pendingId = globalThis.crypto.randomUUID()
      emit(
        notification('chat/edit-pending', {
          runId: getRunId(),
          pendingId,
          toolName: 'Write',
          input,
        }),
      )
      registerAck(pendingId)
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
function buildProposeSkillTool(getRunId, emit, existingSkills = []) {
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
          runId: getRunId(),
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

function buildProposeMultiEditTool(getRunId, emit, vaultPath, registerAck) {
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
          runId: getRunId(),
          pendingId,
          toolName: 'MultiEdit',
          input,
        }),
      )
      registerAck(pendingId)
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

// Move a note OUT of the capture/inbox folder into its resting folder, once its
// durable knowledge has been filed into the wiki. Unlike the propose_* tools
// this is APPLIED IMMEDIATELY, not queued for review — a move is reversible and
// loses no content, so gating it behind an approval card only adds friction.
// The host resolves the note by path and relocates it (docsStore.moveDocToFolder),
// which rewrites its relPath and lets the flush machinery move the file on disk.
function buildMoveNoteTool(getRunId, emit) {
  return tool(
    'move_note',
    "Move a note OUT of the capture/inbox folder into the folder that best fits it — do this AFTER you've filed the note's durable knowledge into the wiki, so the capture folder stays a staging area and not a graveyard. `from_path` is the note's current vault-relative path (e.g. `inbox/some-note.md`); `to_folder` is the destination folder, vault-relative, no leading/trailing slash (e.g. `people`, `projects/acme`). The CLAUDE.md schema governs which folder fits. Applied IMMEDIATELY (not queued for review) and reversible, so only move when you're confident where it belongs; if unsure, leave it in place. Returns immediately — do not wait.",
    {
      from_path: z.string(),
      to_folder: z.string(),
    },
    async (input) => {
      emit(
        notification('chat/move-note', {
          runId: getRunId(),
          fromPath: input.from_path,
          toFolder: input.to_folder,
        }),
      )
      return {
        content: [
          {
            type: 'text',
            text: `Move applied: ${input.from_path} → ${input.to_folder}/`,
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
function buildEditVisualizationTool(getRunId, emit) {
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
          runId: getRunId(),
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
  // the first `result`. Shared by the non-persistent path and, until the
  // thread machinery lands (Stage 2), delegated to by the persistent stub so
  // enabling the flag is behaviour-identical to today.
  #startLegacyRun(runId, params) {
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
      if (this.#turnNeedsRebuild(existing, params) && !existing.turnActive) {
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

  // Whether a new turn's model / permissionMode / fastMode differs from what the
  // thread's query was built with (its optionsSeed). These are fixed at build
  // time, so a change requires a recreate rather than a live mutation.
  #turnNeedsRebuild(rec, params) {
    const seed = rec.optionsSeed ?? {}
    const modeOf = (p) => p.permissionMode ?? 'bypassPermissions'
    return (
      (params.model ?? null) !== (seed.model ?? null) ||
      modeOf(params) !== modeOf(seed) ||
      !!params.fastMode !== !!seed.fastMode
    )
  }

  // Recreate a thread from its persisted session with new params, then replay
  // `item`. The canonical state-transfer path (resume) — used both for a
  // settings change (new model/mode) and for an AUTH restart — instead of
  // mutating the live query. Tears the old thread down first; the identity-
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
        // NOTE: model / permissionMode / fastMode are fixed for a persistent
        // thread (build-time options = turn 1). The host keeps turns that CHANGE
        // these — a model switch, or a plan-mode turn — on the legacy per-turn
        // path (persistentQuery:false); those never spawn surviving background
        // tasks, so they don't need thread persistence. Reconciling mid-stream
        // via setModel/setPermissionMode perturbed the SDK control channel
        // between turns and aborted the turn, so it is intentionally not done.

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
          if (info.status === 'rejected' || overageBlocked) rec.rateLimitRejected = true
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
      this.#finalizeThreadTeardown(rec)
    }
  }

  // Turn boundary. A `result` settles the CURRENT turn (emit chat/done or a
  // typed chat/error) but keeps the thread query alive. A result that arrives
  // with no active turn is an autonomous background continuation — ignored here
  // (Stage 4 routes it to the background surface) so we never emit a runId-less
  // chat/done.
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
      if (rec.dead || rec.turnActive) return
      if (this.#backgroundInFlight(rec)) return // a later event will re-arm
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
      if (rec.dead || rec.turnActive || this.#backgroundInFlight(rec)) continue
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
  #teardownThread(rec, _reason) {
    if (rec.dead) return
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

// Codes the user can't fix by retrying the same request. Used to set the
// `retryable` flag (host hides the Retry button for these).
const NON_RETRYABLE_CODES = new Set(['AUTH', 'INVALID', 'BILLING', 'BUDGET'])

// Shape the SDK's `rate_limit_info` into the compact reset payload the host
// attaches to a RATE_LIMIT error (resetsAt drives the countdown / date;
// rateLimitType + overageDisabledReason pick the distinct copy). Returns
// undefined when there's nothing to carry so the field is simply absent.
function rateLimitPayload(info) {
  if (!info) return undefined
  // When the block is on the overage (paid) budget, the reset lives in
  // `overageResetsAt`, not `resetsAt` (sdk.d.ts SDKRateLimitInfo) — fall back to
  // it so an overage rejection still shows a countdown instead of a blank one.
  const resetsAt =
    typeof info.resetsAt === 'number'
      ? info.resetsAt
      : typeof info.overageResetsAt === 'number'
        ? info.overageResetsAt
        : undefined
  return {
    resetsAt,
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
