// SDK stream → MessagePart translator. Owns the mutable state that
// turns Anthropic's raw `content_block_*` events into the timeline
// the chat panel renders.
//
// Why a factory + closure: the parser holds three Maps and a small
// scalar (last rate-limit snapshot) that mutate together as events
// arrive. Encapsulating them in a closure (vs a class) lets the
// returned object expose just the entry points the engine needs
// (`handleEvent`, plus a couple of read accessors) without making any
// of the internal state directly reachable.
//
// LEGACY: `findPendingProposalPart` / `stampProposalApplied` (and the
// markId-preservation branch in the tool_result handler) once served a
// separate `proposalListener` that stamped a `claude:proposal` outcome
// back onto the matching ToolPart. That listener was removed (commit
// "drop mark/propose_change for direct edit_document writes"); AI edits
// now flow through the pending-changes store (see agent/chat/index.ts +
// pendingChangesStore). These accessors are currently UNUSED.

import type {
  MessagePart,
  ReasoningPart,
  TextPart,
  ToolPart,
} from '@/chat/types'
import { isProposeEditTool } from '@/chat/parts/proposeChangeTool'
import type { ChatEvent } from './types'

/** Best-effort error text extraction from a tool_result content
 * block. Anthropic returns content as either a plain string, a
 * single text block, or an array of blocks; we handle all three. */
export function extractErrorText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const text = content
      .map((b) =>
        typeof b === 'object' && b && 'text' in b
          ? String((b as { text?: unknown }).text ?? '')
          : '',
      )
      .join('')
    return text || undefined
  }
  return undefined
}

/** crypto.randomUUID() shape. The sidecar's edit tools echo the queued
 * PendingChange's id in their tool_result text ("…(id: <uuid>)."); this
 * pulls it back out so the part can be linked to its store entry. */
const PENDING_ID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** SDK event kinds we deliberately drop without surfacing — pure transport /
 * lifecycle metadata, not chat content. `result` is consumed separately via the
 * `claude:done` notification; `system/init` serves only as a session-exists
 * latch (index.ts); `auth_status` is handled by the host's token flow. Anything
 * NOT in this set that falls through to the parser's floor is treated as an
 * unhandled signal (see {@link noteUnhandledEvent}) — so the difference between
 * "intentionally ignored" and "silently missed" is explicit, not accidental. */
const IGNORED_EVENT_KEYS = new Set<string>([
  'result',
  'system/init',
  'auth_status',
])

/** Unhandled-event kinds already reported, so prod logs each kind at most once
 * (per app session) instead of on every occurrence. Module-scoped: the dedup is
 * global, not per-parser-instance — the same kind from any run is noted once. */
const seenUnhandledKeys = new Set<string>()

/** Stable identity of an SDK event for ignore/dedup purposes: `system` messages
 * are keyed by their subtype (that's where their meaning lives — `system/init`
 * vs `system/status`), everything else by top-level type. */
function eventKey(ev: ChatEvent['event']): string {
  if (ev?.type === 'system') return `system/${ev.subtype ?? '?'}`
  return ev?.type ?? '?'
}

/** Default channel for any event that reached the parser without a handler.
 * Deliberately-ignored plumbing (see {@link IGNORED_EVENT_KEYS}) passes
 * silently; a genuinely unrecognized signal is surfaced — loudly in dev (so we
 * notice new SDK events and can decide whether to render them), quietly counted
 * in prod. Never renders anything to the user; UX for a signal is only added by
 * giving it a real handler above. */
function noteUnhandledEvent(ev: ChatEvent['event']): void {
  const key = eventKey(ev)
  if (IGNORED_EVENT_KEYS.has(key)) return
  if (seenUnhandledKeys.has(key)) return
  seenUnhandledKeys.add(key)
  if (import.meta.env.DEV) {
    console.warn(`[streamParser] unhandled SDK event: ${key}`, ev)
  }
}

export interface StreamParser {
  /** Feed one `claude:event` payload (already runId-filtered by the
   * caller). The parser updates its internal timeline and emits any
   * resulting MessagePart(s) via the `onPart` callback registered at
   * factory time. */
  handleEvent(event: ChatEvent['event']): void

  /** Most recent SDK rate_limit_event observed. The engine reads
   * this on the error path to attach a precise countdown to the
   * rejected Error when the run fails with code `RATE_LIMIT`. */
  rateLimitInfo(): ChatEvent['event']['rate_limit_info'] | undefined

  /** LEGACY (unused — see file header). First unstamped `propose_change`
   * tool part in insertion order, matched by order because the removed
   * proposal listener's notification had no tool_use_id. */
  findPendingProposalPart(): ToolPart | undefined

  /** LEGACY (unused — see file header). Stamped the apply outcome (a
   * markId) onto a propose_change tool part so the chat panel's
   * click-to-scroll handler could find the resulting mark. */
  stampProposalApplied(part: ToolPart, markId: string): void
}

export interface StreamParserArgs {
  onPart?: (part: MessagePart) => void
  onTextDelta?: (delta: string) => void
  onThinkingDelta?: (delta: string) => void
}

export function createStreamParser(args: StreamParserArgs): StreamParser {
  const { onPart, onTextDelta, onThinkingDelta } = args

  // Mutable mirror of the parts timeline — kept locally so we can
  // update an existing part (e.g. append a text delta) by reading
  // its prior state and re-emitting the new whole. The caller
  // treats `part.id` as identity and upserts.
  const partsById = new Map<string, MessagePart>()
  // "(parentToolUseId|'')#index" → partId for the open content_block.
  // Anthropic's raw stream uses an index per concurrent block; we route deltas
  // via this. Keyed by the SUBAGENT parent too (not just index) so a
  // subagent's block 0 doesn't collide with the main thread's — or another
  // parallel subagent's — block 0 streaming at the same time.
  const blockKeyToPartId = new Map<string, string>()
  const blockKey = (parentId: string | undefined, idx: number) =>
    `${parentId ?? ''}#${idx}`
  // Tool input arrives as fragments of JSON via input_json_delta.
  // We keep the partial string per part until content_block_stop,
  // then JSON.parse.
  const toolInputFragments = new Map<string, string>()
  // Most recent SDK rate_limit_event observed during the run.
  let lastRateLimitInfo: ChatEvent['event']['rate_limit_info'] | undefined

  const upsertPart = (part: MessagePart) => {
    partsById.set(part.id, part)
    onPart?.(part)
  }

  const findToolPartByCallId = (toolCallId: string): ToolPart | undefined => {
    for (const p of partsById.values()) {
      if (p.type === 'tool' && p.toolCallId === toolCallId) return p
    }
    return undefined
  }

  return {
    handleEvent(ev) {
      // 1) Live token streaming — Anthropic's raw content_block_*
      // events.
      if (ev?.type === 'stream_event') {
        const inner = ev.event
        const parentId = ev.parent_tool_use_id ?? undefined
        // Subagent content is NOT rendered from these partials: forwardSubagentText
        // also delivers each subagent message in full (handled in the `assistant`
        // / `user` branches below, keyed for idempotency), so consuming the
        // partials too would double-count the same step. Drop subagent partials
        // here; the main thread (parentId null) streams normally below.
        if (parentId) return
        // Block opens — register a part of the right type at this
        // index.
        if (inner?.type === 'content_block_start') {
          const idx = inner.index ?? 0
          const key = blockKey(parentId, idx)
          const block = inner.content_block ?? {}
          const partId = crypto.randomUUID()
          const ts = Date.now()
          if (block.type === 'text') {
            const part: TextPart = { id: partId, ts, type: 'text', text: block.text ?? '', parentToolUseId: parentId }
            blockKeyToPartId.set(key, partId)
            upsertPart(part)
          } else if (block.type === 'thinking') {
            const part: ReasoningPart = { id: partId, ts, type: 'reasoning', text: block.thinking ?? '', parentToolUseId: parentId }
            blockKeyToPartId.set(key, partId)
            upsertPart(part)
          } else if (block.type === 'tool_use') {
            const part: ToolPart = {
              id: partId,
              ts,
              type: 'tool',
              toolName: block.name ?? '<unknown>',
              toolCallId: block.id ?? partId,
              input: {},
              state: 'input-streaming',
              parentToolUseId: parentId,
            }
            blockKeyToPartId.set(key, partId)
            toolInputFragments.set(partId, '')
            upsertPart(part)
          } else if (block.type === 'redacted_thinking') {
            // The model produced reasoning that the safety layer encrypted —
            // its `data` is opaque, so there is nothing readable to show.
            // We INTENTIONALLY skip it (no part registered): a "[redacted]"
            // placeholder would be pure noise. This branch exists so the drop
            // is deliberate, not a silently-unhandled block type. (No deltas
            // follow a redacted_thinking block.)
          }
          return
        }

        // Deltas — append to whichever block is open at this index.
        if (inner?.type === 'content_block_delta') {
          const idx = inner.index ?? 0
          const partId = blockKeyToPartId.get(blockKey(parentId, idx))
          const d = inner.delta
          if (partId && d) {
            const prev = partsById.get(partId)
            if (prev?.type === 'text' && d.type === 'text_delta' && d.text) {
              upsertPart({ ...prev, text: prev.text + d.text })
              onTextDelta?.(d.text)
            } else if (prev?.type === 'reasoning' && d.type === 'thinking_delta' && d.thinking) {
              upsertPart({ ...prev, text: prev.text + d.thinking })
              onThinkingDelta?.(d.thinking)
            } else if (prev?.type === 'tool' && d.type === 'input_json_delta' && d.partial_json) {
              const buf = (toolInputFragments.get(partId) ?? '') + d.partial_json
              toolInputFragments.set(partId, buf)
              // Don't try to parse mid-stream; just keep the raw
              // fragment visible via input until stop.
              upsertPart({ ...prev, input: buf })
            }
          }
          return
        }

        // Block closes — for tool_use, parse accumulated JSON and
        // flip state.
        if (inner?.type === 'content_block_stop') {
          const idx = inner.index ?? 0
          const key = blockKey(parentId, idx)
          const partId = blockKeyToPartId.get(key)
          blockKeyToPartId.delete(key)
          if (partId) {
            const prev = partsById.get(partId)
            if (prev?.type === 'tool') {
              const buf = toolInputFragments.get(partId) ?? ''
              toolInputFragments.delete(partId)
              let parsed: unknown = buf
              try { parsed = buf ? JSON.parse(buf) : {} } catch { /* leave raw string */ }
              upsertPart({ ...prev, input: parsed, state: 'input-available' })
            }
          }
          return
        }
        return
      }

      // 1b) Context compaction — the SDK summarized earlier turns to stay
      // under the window. Drop a divider part into the timeline at this point.
      if (ev?.type === 'system' && ev.subtype === 'compact_boundary') {
        const m = ev.compact_metadata ?? {}
        upsertPart({
          id: crypto.randomUUID(),
          ts: Date.now(),
          type: 'compact',
          trigger: m.trigger === 'manual' ? 'manual' : 'auto',
          preTokens: typeof m.pre_tokens === 'number' ? m.pre_tokens : undefined,
          postTokens: typeof m.post_tokens === 'number' ? m.post_tokens : undefined,
        })
        return
      }

      // 1c) Subagent heartbeat — task_started / task_progress carry the running
      // subagent's tool/token counts. Stamp them onto the parent Task tool part
      // (matched by tool_use_id) so its row shows live progress.
      if (
        ev?.type === 'system' &&
        (ev.subtype === 'task_progress' || ev.subtype === 'task_started')
      ) {
        const tid = ev.tool_use_id
        const part = tid ? findToolPartByCallId(tid) : undefined
        if (part) {
          const u = ev.usage ?? {}
          upsertPart({
            ...part,
            task: {
              toolUses:
                typeof u.tool_uses === 'number' ? u.tool_uses : part.task?.toolUses,
              totalTokens:
                typeof u.total_tokens === 'number' ? u.total_tokens : part.task?.totalTokens,
              lastTool:
                typeof ev.last_tool_name === 'string' ? ev.last_tool_name : part.task?.lastTool,
              summary:
                typeof ev.summary === 'string' ? ev.summary : part.task?.summary,
            },
          })
        }
        return
      }

      // 1d) API auto-retry — the SDK hit a transient error (429 / 5xx) and is
      // retrying after a back-off, staying silent meanwhile. Coalesce into a
      // single updating row (constant id) so the pause reads as "recovering",
      // not "hung". Superseded into the process summary once events resume.
      if (ev?.type === 'system' && ev.subtype === 'api_retry') {
        upsertPart({
          id: 'api-retry',
          ts: Date.now(),
          type: 'retry',
          attempt: typeof ev.attempt === 'number' ? ev.attempt : undefined,
          maxRetries: typeof ev.max_retries === 'number' ? ev.max_retries : undefined,
          error: typeof ev.error === 'string' ? ev.error : undefined,
        })
        return
      }

      // 1e) Live transport status. `compacting` is the only user-facing one:
      // the SDK is summarizing older turns to fit the window — a multi-second
      // pause that otherwise shows nothing. Coalescing row (constant id), folds
      // into the process summary once the turn moves on. `requesting`/null are
      // intentionally NOT surfaced (pure "waiting on the API" noise).
      if (ev?.type === 'system' && ev.subtype === 'status') {
        if (ev.status === 'compacting') {
          upsertPart({ id: 'status', ts: Date.now(), type: 'status', state: 'compacting' })
        }
        return
      }

      // 1f) A tool call was auto-denied (deny rule / classifier / mode) with no
      // interactive prompt — e.g. our secret-file / egress deny rules blocking
      // the model. Without this the model just quietly works around it and the
      // user can't tell why. Persistent notice row.
      if (ev?.type === 'system' && ev.subtype === 'permission_denied') {
        upsertPart({
          id: crypto.randomUUID(),
          ts: Date.now(),
          type: 'notice',
          kind: 'permission-denied',
          toolName: typeof ev.tool_name === 'string' ? ev.tool_name : undefined,
          reason: typeof ev.decision_reason === 'string' ? ev.decision_reason : undefined,
        })
        return
      }

      // 1g) The SDK re-served a refused request on a fallback model. The reply's
      // tone/quality can shift; surface which model answered.
      if (ev?.type === 'system' && ev.subtype === 'model_refusal_fallback') {
        upsertPart({
          id: crypto.randomUUID(),
          ts: Date.now(),
          type: 'notice',
          kind: 'model-fallback',
          fallbackModel: typeof ev.fallback_model === 'string' ? ev.fallback_model : undefined,
        })
        return
      }

      // 1h) An SDK `informational` message meant for the user. `level: 'info'` is
      // transcript-only (not surfaced); notice/suggestion/warning render.
      if (ev?.type === 'system' && ev.subtype === 'informational') {
        const level = ev.level
        if (level === 'notice' || level === 'suggestion' || level === 'warning') {
          upsertPart({
            id: crypto.randomUUID(),
            ts: Date.now(),
            type: 'notice',
            kind: 'info',
            text: typeof ev.content === 'string' ? ev.content : undefined,
            level,
            blocking: ev.prevent_continuation === true,
          })
        }
        return
      }

      // 2) Assistant message.
      if (ev?.type === 'assistant') {
        const parentId = ev.parent_tool_use_id ?? undefined
        // Main-thread assistant messages are already rendered token-by-token
        // from stream_event, so the consolidated copy is a no-op. SUBAGENT
        // messages (parentId set) are NOT streamed as partials we keep — with
        // forwardSubagentText the subagent's text / thinking / tool_use arrive
        // here as whole messages, so build the lane's child parts from them.
        if (!parentId) return
        const blocks = ev.message?.content
        if (Array.isArray(blocks)) {
          blocks.forEach((b, idx) => {
            // Key by the message uuid + block index so a re-emitted snapshot of
            // the same message upserts the same part instead of duplicating.
            const key = `${ev.uuid ?? 'sub'}:${parentId}:${idx}`
            if (b.type === 'text' && b.text) {
              upsertPart({ id: key, ts: Date.now(), type: 'text', text: b.text, parentToolUseId: parentId })
            } else if (b.type === 'thinking' && b.thinking) {
              upsertPart({ id: key, ts: Date.now(), type: 'reasoning', text: b.thinking, parentToolUseId: parentId })
            } else if (b.type === 'tool_use') {
              upsertPart({
                id: key,
                ts: Date.now(),
                type: 'tool',
                toolName: b.name ?? '<unknown>',
                // Real tool_use id so the subagent's tool_result (a `user`
                // message) resolves onto this part by toolCallId.
                toolCallId: b.id ?? key,
                input: b.input ?? {},
                state: 'input-available',
                parentToolUseId: parentId,
              })
            }
          })
        }
        return
      }

      // 3) User message with tool_result — resolve the matching
      // tool part.
      if (ev?.type === 'user') {
        const blocks = ev.message?.content
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (b.type === 'tool_result' && b.tool_use_id) {
              const tool = findToolPartByCallId(b.tool_use_id)
              if (tool) {
                const isError = !!b.is_error
                // LEGACY (see file header): the removed proposal listener
                // could stamp a markId onto a propose_change part before
                // this tool_result landed; preserving it kept the SDK ack
                // from erasing it. That path is inert now (nothing stamps),
                // so `existing.markId` is always undefined here — kept as a
                // harmless guard until the legacy accessors are removed.
                const existing = (tool.output ?? {}) as { markId?: string }
                const stampedMarkId = !isError ? existing.markId : undefined
                // Edit tools (propose_edit / write / multi_edit) echo the
                // queued PendingChange id in their result text. Capture it
                // so the inline suggestion card can find the matching store
                // entry and drive Keep / Reject.
                let pendingId = tool.pendingId
                if (!isError && isProposeEditTool(tool.toolName)) {
                  const match = PENDING_ID_RE.exec(
                    extractErrorText(b.content) ?? '',
                  )
                  if (match) pendingId = match[0]
                }
                upsertPart({
                  ...tool,
                  state: isError ? 'output-error' : 'output-available',
                  output: stampedMarkId
                    ? { ok: true, markId: stampedMarkId, content: b.content }
                    : b.content,
                  errorText: isError ? extractErrorText(b.content) : undefined,
                  pendingId,
                })
              }
            }
          }
        }
        return
      }

      // 4) Rate-limit info — snapshot for the error path.
      if (ev?.type === 'rate_limit_event' && ev.rate_limit_info) {
        lastRateLimitInfo = ev.rate_limit_info
        return
      }

      // 5) Default channel. Anything that reached here had no handler above.
      // Two cases:
      //   (a) Known transport / lifecycle plumbing we deliberately never
      //       surface (see IGNORED_EVENT_KEYS) — dropped silently. That set is
      //       the explicit record of "handled by choosing NOT to show it".
      //   (b) A signal we don't (yet) handle. Surfaced by noteUnhandledEvent —
      //       loudly in dev so a new/unrecognized SDK event can't slip past us,
      //       quietly counted in prod (no user-facing noise). This is the
      //       safety net that stops us silently dropping SDK capabilities as
      //       the SDK evolves.
      noteUnhandledEvent(ev)
    },

    rateLimitInfo() {
      return lastRateLimitInfo
    },

    findPendingProposalPart() {
      for (const p of partsById.values()) {
        if (p.type !== 'tool') continue
        if (p.toolName !== 'propose_change') continue
        const existing = (p.output ?? {}) as { markId?: string }
        if (existing.markId) continue
        return p
      }
      return undefined
    },

    stampProposalApplied(part, markId) {
      upsertPart({
        ...part,
        state: 'output-available',
        output: { ok: true, markId, content: 'Proposal recorded.' },
      })
    },
  }
}
