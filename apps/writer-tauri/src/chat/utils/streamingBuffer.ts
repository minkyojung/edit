import type { MessagePart } from '@/chat/types'

/** In-flight assistant turn's parts timeline, kept as a Map plus a stable
 * insertion-order array so an upsert can update an existing part (e.g. a
 * text delta extending the same part) without disturbing earlier ones.
 *
 * Lives outside React state on purpose — every delta from the SDK calls
 * `upsert`, but only the throttled flush (caller's concern) projects this
 * into render state. Keeping the buffer mutable and local skips the React
 * reconciliation cost on the hot path. */
export interface StreamingBuffer {
  /** Add a brand-new part or replace an existing one with the same id. */
  upsert: (part: MessagePart) => void
  /** Snapshot the parts in their original arrival order. */
  buildParts: () => MessagePart[]
  /** Concatenate the `.text` of every MAIN-THREAD part of the given type, in
   * order. Subagent parts (those carrying a `parentToolUseId`) are skipped —
   * they belong to a nested lane, and folding their text into the orchestrator's
   * own `content` / `thinking` would pollute the answer, Copy output, and prompt
   * history. Used to derive the legacy `content` / `thinking` fields. */
  joinByType: (type: 'text' | 'reasoning') => string
}

export function createStreamingBuffer(): StreamingBuffer {
  const partsById = new Map<string, MessagePart>()
  const partOrder: string[] = []
  return {
    upsert(part) {
      if (!partsById.has(part.id)) partOrder.push(part.id)
      partsById.set(part.id, part)
    },
    buildParts() {
      return partOrder.map((id) => partsById.get(id)!).filter(Boolean)
    },
    joinByType(type) {
      let out = ''
      for (const id of partOrder) {
        const p = partsById.get(id)
        if (p?.type === type && !('parentToolUseId' in p && p.parentToolUseId)) {
          out += p.text
        }
      }
      return out
    },
  }
}
