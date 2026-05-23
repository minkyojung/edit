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
  // index → partId for the open content_block at that index.
  // Anthropic's raw stream uses an index per concurrent block; we
  // route deltas via this.
  const blockIndexToPartId = new Map<number, string>()
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
        // Block opens — register a part of the right type at this
        // index.
        if (inner?.type === 'content_block_start') {
          const idx = inner.index ?? 0
          const block = inner.content_block ?? {}
          const partId = crypto.randomUUID()
          const ts = Date.now()
          if (block.type === 'text') {
            const part: TextPart = { id: partId, ts, type: 'text', text: block.text ?? '' }
            blockIndexToPartId.set(idx, partId)
            upsertPart(part)
          } else if (block.type === 'thinking') {
            const part: ReasoningPart = { id: partId, ts, type: 'reasoning', text: block.thinking ?? '' }
            blockIndexToPartId.set(idx, partId)
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
            }
            blockIndexToPartId.set(idx, partId)
            toolInputFragments.set(partId, '')
            upsertPart(part)
          }
          return
        }

        // Deltas — append to whichever block is open at this index.
        if (inner?.type === 'content_block_delta') {
          const idx = inner.index ?? 0
          const partId = blockIndexToPartId.get(idx)
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
          const partId = blockIndexToPartId.get(idx)
          blockIndexToPartId.delete(idx)
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

      // 2) Final assistant message — already covered by stream_event.
      if (ev?.type === 'assistant') return

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
                upsertPart({
                  ...tool,
                  state: isError ? 'output-error' : 'output-available',
                  output: stampedMarkId
                    ? { ok: true, markId: stampedMarkId, content: b.content }
                    : b.content,
                  errorText: isError ? extractErrorText(b.content) : undefined,
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
