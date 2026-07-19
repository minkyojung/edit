// Relay tools: MCP tool definitions whose handlers do NOT perform the action —
// they forward the model's proposal to the host (frontend) via a notification
// and return success immediately. The host owns the editor/UI and does the real
// work (queue for review, or apply immediately for move/viz). Extracted from
// server.mjs; every factory takes its host deps as parameters (getRunId, emit,
// vaultPath, registerAck) — no coupling to the Server instance.

import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, normalize, resolve as resolvePath } from 'node:path'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { notification } from '../jsonrpc.mjs'

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
export function extractPendingId(toolResponse) {
  let text
  try {
    text = typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse ?? '')
  } catch {
    return null
  }
  const match = /\(id:\s*([0-9a-f-]{36})\)/i.exec(text ?? '')
  return match ? match[1] : null
}

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
export function buildProposeEditTool(getRunId, emit, vaultPath, registerAck) {
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

export function buildProposeWriteTool(getRunId, emit, registerAck) {
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
export function buildProposeSkillTool(getRunId, emit, existingSkills = []) {
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

export function buildProposeMultiEditTool(getRunId, emit, vaultPath, registerAck) {
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
export function buildMoveNoteTool(getRunId, emit) {
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
export function buildEditVisualizationTool(getRunId, emit) {
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
