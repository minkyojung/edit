// proof-sdk stores the author of every mark as a single tagged
// string in `by` — "ai:<model-id>" for LLM-generated marks,
// "human:<name>" for user-generated ones. Both come straight from
// the agent-bridge wire format, so display surfaces have to parse
// the prefix.
//
// Returns a short user-facing label (e.g. "sonnet", "alice") or
// null when there's nothing meaningful to show (missing field, the
// "human:unknown" placeholder we fall back to during seeding).

import { formatModel } from './formatModel'

export function formatActor(by: string | null | undefined): string | null {
  if (!by) return null
  if (by.startsWith('ai:')) {
    const id = by.slice(3).trim()
    return id ? formatModel(id) : null
  }
  if (by.startsWith('human:')) {
    const name = by.slice(6).trim()
    if (!name || name === 'unknown') return null
    return name
  }
  return by
}
