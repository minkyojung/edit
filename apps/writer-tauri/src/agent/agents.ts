// Agent registry + resolver — the "session = agent" seam.
//
// An agent is a ROLE: a persona (systemPrompt) plus an optional memory
// namespace (memoryType — a `system:memory:<id>` vault doc the agent
// reads at session start). A thread carries an `agentId`
// (ThreadMeta.agentId); the chat runner resolves it here to pick the
// prompt body and the memory slot to inject.
//
// Today there is exactly one built-in agent (`default`) and no UX to
// create others — `resolveAgent` always returns DEFAULT_AGENT, so the
// swap is a no-op and behaviour is unchanged. The indirection is the
// point: role creation / selection can be layered in later (populate
// the registry, or load role docs from the vault) without touching the
// runner — `resolveAgent` just starts returning the chosen role.

import { FREE_CHAT_PROMPT } from './skills/freeChat'

export interface Agent {
  /** Stable id persisted on `ThreadMeta.agentId`. Also derives the
   * memory doc type (`system:memory:<id>`). */
  id: string
  /** Human-facing label (future role picker / attribution). */
  name: string
  /** System-prompt framing for this role. */
  systemPrompt: string
  /** Vault doc type this agent reads its long-term memory from, or
   * `null` when the agent has no dedicated memory. */
  memoryType: string | null
}

/** The single built-in agent. Its prompt is the existing free-chat
 * framing and its memory namespace is `system:memory:default`. */
export const DEFAULT_AGENT: Agent = {
  id: 'default',
  name: '기본',
  systemPrompt: FREE_CHAT_PROMPT,
  memoryType: 'system:memory:default',
}

/** Resolve a thread's `agentId` to its {@link Agent}. Unknown / missing
 * ids fall back to {@link DEFAULT_AGENT}. Currently always returns
 * DEFAULT_AGENT — this is the seam where role lookup will plug in. */
export function resolveAgent(_agentId?: string): Agent {
  return DEFAULT_AGENT
}
