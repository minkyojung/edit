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
  /** Concatenate the `.text` of every part of the given type, in order.
   * Used to derive the legacy `content` / `thinking` fields the rest of the
   * UI (and prompt history) still reads. */
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
        if (p?.type === type) out += p.text
      }
      return out
    },
  }
}
