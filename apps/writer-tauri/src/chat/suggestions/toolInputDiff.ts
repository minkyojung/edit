// Build read-only diff lines straight from an edit tool's input.
//
// Used for the historical record in chat: the live PendingChange is
// pruned from the store ~10 min after a decision, but the message — and
// thus `part.input` — is permanent (Yjs). So when the store entry is
// gone we still reconstruct what the edit proposed from the message
// itself, keeping the diff visible when the user scrolls back.
//
// Returns [] when the input isn't decoded yet (still streaming) or the
// tool shape is unrecognised, so the caller can fall back to a minimal
// status line.

import { diffPairsToLines } from '@/lib/pendingDiff'
import type { DiffLine } from '@/lib/git'

export function diffLinesFromToolInput(
  toolName: string,
  input: unknown,
): DiffLine[] {
  if (input === null || typeof input !== 'object') return []
  const o = input as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : '')

  if (toolName === 'mcp__writer-relay__propose_edit') {
    return diffPairsToLines([
      { before: str(o.old_string), after: str(o.new_string) },
    ])
  }
  if (toolName === 'mcp__writer-relay__propose_write') {
    return diffPairsToLines([{ before: '', after: str(o.content) }])
  }
  if (toolName === 'mcp__writer-relay__propose_multi_edit') {
    const edits = Array.isArray(o.edits) ? o.edits : []
    const pairs = edits
      .filter(
        (e): e is Record<string, unknown> => !!e && typeof e === 'object',
      )
      .map((e) => ({ before: str(e.old_string), after: str(e.new_string) }))
    return diffPairsToLines(pairs)
  }
  return []
}
