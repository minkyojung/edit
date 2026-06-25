// SDK stream → MessagePart translator. Owns the mutable state that
// turns Anthropic's raw `content_block_*` events into the timeline
// the chat panel renders.
//
// Why a factory + closure: the parser holds three Maps and a small
// scalar (last rate-limit snapshot) that mutate together as events
// arrive. Encapsulating them in a closure (vs a class) lets the
// returned object expose just the entry points the engine needs
// (`handleEvent`, plus two read accessors used by the proposal
// listener) without making any of the internal state directly
// reachable.
//
// `claude:proposal` is NOT handled here. It runs in a separate
// listener (proposalListener.ts) that calls `findPendingProposalPart`
// + `stampProposalApplied` to merge its own outcome into the
// matching ToolPart this parser created.

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

  /** First unstamped `propose_change` tool part in insertion order.
   * The proposal listener correlates a `claude:proposal` event with
   * this part — the sidecar's notification has no tool_use_id, so
   * we match by order (tool_use blocks land here in model-emission
   * order, and Map iteration preserves insertion). */
  findPendingProposalPart(): ToolPart | undefined

  /** Stamp the apply outcome onto a propose_change tool part so the
   * chat panel's click-to-scroll handler can find the resulting
   * mark. The SDK's tool_result that arrives a beat later only
   * carries the ack text from the relay handler — without this
   * stamp the markId would never reach the UI. */
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
                // propose_change parts may have already had their
                // output stamped with a markId by the proposal
                // listener. The SDK's tool_result carries only
                // the relay handler's ack text, so blindly
                // overwriting would erase the markId and break the
                // chat → editor click-to-scroll path. Preserve the
                // stamped markId when one is present.
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

      // 5) Everything else (system, result, …) — SDK transport
      // metadata, not chat content. The Vercel `parts` model only
      // carries text/reasoning/tool/source/file/step-*, so we
      // mirror that and drop anything outside the whitelist on the
      // floor.
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
