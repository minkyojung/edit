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

/** How long a propose_* handler waits for the host's verdict before assuming
 * success. Local IPC to the host's own process, so this only elapses when the
 * host is wedged — and then failing OPEN is right: a lost ack must not wedge
 * the turn too. */
const ACK_TIMEOUT_MS = 15000

/** Block on the host's verdict for a proposal, then release the slot.
 * Shared by all three propose_* tools so the fail-open policy is one fact. */
async function awaitVerdict(promise, cleanup) {
  try {
    return await Promise.race([
      promise,
      new Promise((r) => setTimeout(() => r({ ok: true, reason: null, applied: false }), ACK_TIMEOUT_MS)),
    ])
  } finally {
    cleanup()
  }
}

/** The tool result for a staged edit, chosen by the host's verdict.
 *
 * These three texts used to be produced by a PostToolUse hook that REWROTE an
 * optimistic "queued" string the handler had already returned. That hook landed
 * only ~2/3 of the time, so a refusal frequently never reached the model — and
 * an unrefused model, seeing the file unchanged (staging leaves disk alone by
 * design), concluded the call had failed and proposed the same edit again. One
 * logical edit, two review cards. Returning the verdict directly removes the
 * race: there is no optimistic claim to correct. */
function stagedEditResult(verdict, pendingId, kind) {
  const said = (text) => ({ content: [{ type: 'text', text }] })
  if (verdict && verdict.ok === false) {
    return said(
      `(error: this proposal was NOT queued${verdict.reason ? ` — ${verdict.reason}` : ''}. ` +
        `No review card was created and the file is unchanged. Re-read the file to see ` +
        `its current content, then propose the edit again against that text.)`,
    )
  }
  // Auto-accept mode wrote it straight to disk — tell the model so it doesn't
  // later advise the user to "reject the review card" that never existed.
  if (verdict && verdict.applied) {
    return said(
      'Applied immediately — auto-accept mode is on, so this change is already ' +
        'saved to the file. There is no review card to accept or reject. To undo ' +
        'it later, revert the change (see the undo-ai-change skill); never tell ' +
        'the user to reject it.',
    )
  }
  return said(
    `${kind === 'Edit' ? 'Edit' : 'MultiEdit'} queued for user review (id: ${pendingId}). ` +
      `The file is intentionally NOT modified until the user accepts, so do not re-read it to verify — ` +
      `it will still show the old text and that does not mean this call failed. ` +
      `Do not propose ${kind === 'Edit' ? 'this edit' : 'these edits'} again.`,
  )
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
    'PREFERRED tool for changing an existing file. Propose a surgical edit: provide the absolute file_path, the exact old_string to replace (copy it VERBATIM from the file — Read it first if unsure), and the new_string. old_string MUST identify exactly ONE place in the file — if the text appears more than once, include enough surrounding lines to make it unique, otherwise the edit is rejected as ambiguous (the host never guesses which occurrence you meant). Works like the built-in Edit tool with ONE difference that matters: the change is STAGED for the user to review, and the file on disk stays unchanged until they accept it. So after a successful call, do NOT re-read the file to check your edit landed — it will still show the old text, and that is the expected state, not a failure. Returns immediately — do not wait for the user. `reason`: a short one-line note recorded in the VERSION HISTORY (the commit log) for this edit — say what changed and why in plain terms. It is NOT shown in your chat reply; it is the audit trail so the user can later see why a change was made. Keep it specific ("Fixed the typo in the intro", "Added the 2026 pricing row"), not generic.',
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
      const { promise, cleanup } = registerAck(pendingId)
      emit(
        notification('chat/edit-pending', {
          runId: getRunId(),
          pendingId,
          toolName: 'Edit',
          input,
        }),
      )
      // Round-trip on the host's verdict rather than returning an optimistic
      // "queued" — see stagedEditResult for why the optimistic form produced
      // duplicate review cards.
      return stagedEditResult(await awaitVerdict(promise, cleanup), pendingId, 'Edit')
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
      const { promise, cleanup } = registerAck(pendingId)
      emit(
        notification('chat/edit-pending', {
          runId: getRunId(),
          pendingId,
          toolName: 'Write',
          input,
        }),
      )
      // Round-trip: block on the host's apply verdict and return it DIRECTLY.
      // A whole-doc write can be refused — the file changed under the model
      // (compare-and-swap), or the edit didn't map — and the model must SEE
      // that deterministically and rewrite. Unlike the fire-and-forget
      // propose_edit path, this does NOT return an optimistic "queued": that
      // would let a stale overwrite look successful. Fail open if the host
      // never answers, so a lost ack can't wedge the turn.
      const verdict = await awaitVerdict(promise, cleanup)
      if (verdict && verdict.ok === false) {
        return {
          content: [
            {
              type: 'text',
              text:
                `(error: the write was NOT applied — ` +
                `${verdict.reason ?? 'the file changed since you read it'}. ` +
                `Do not resubmit the same content; rewrite against the current ` +
                `content shown above and call the write tool again.)`,
            },
          ],
        }
      }
      // Auto-accept mode wrote it straight to disk — tell the model so it doesn't
      // later advise the user to "reject the review card" that never existed.
      if (verdict && verdict.applied) {
        return {
          content: [
            {
              type: 'text',
              text:
                'Applied immediately — auto-accept mode is on, so this file is ' +
                'already saved. There is no review card to accept or reject. To ' +
                'undo it later, revert the change (see the undo-ai-change skill); ' +
                'never tell the user to reject it.',
            },
          ],
        }
      }
      return {
        content: [
          {
            type: 'text',
            text:
              `Write queued for user review (id: ${pendingId}). ` +
              `The file is intentionally NOT modified until the user accepts, so do not re-read it to verify — ` +
              `it will still show the old content and that does not mean this call failed. Do not propose this write again.`,
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
      const { promise, cleanup } = registerAck(pendingId)
      emit(
        notification('chat/edit-pending', {
          runId: getRunId(),
          pendingId,
          toolName: 'MultiEdit',
          input,
        }),
      )
      return stagedEditResult(await awaitVerdict(promise, cleanup), pendingId, 'MultiEdit')
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
