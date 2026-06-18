// Agent registry + resolver — the "session = agent" seam.
//
// An agent is a ROLE: a persona (systemPrompt). A thread carries an
// `agentId` (ThreadMeta.agentId); the chat runner resolves it here to
// pick the prompt body. (Agents have no dedicated long-term "memory"
// surface — durable facts the user wants remembered live in the wiki /
// self-profile, injected via assembleContext and edited through the
// normal proposal flow.)
//
// Today there is exactly one built-in agent (`default`) and no UX to
// create others — `resolveAgent` always returns DEFAULT_AGENT, so the
// swap is a no-op and behaviour is unchanged. The indirection is the
// point: role creation / selection can be layered in later (populate
// the registry, or load role docs from the vault) without touching the
// runner — `resolveAgent` just starts returning the chosen role.

import { FREE_CHAT_PROMPT } from './skills/freeChat'

export interface Agent {
  /** Stable id persisted on `ThreadMeta.agentId`. */
  id: string
  /** Human-facing label (future role picker / attribution). */
  name: string
  /** System-prompt framing for this role. */
  systemPrompt: string
}

/** The single built-in agent. Its prompt is the existing free-chat
 * framing. */
export const DEFAULT_AGENT: Agent = {
  id: 'default',
  name: '기본',
  systemPrompt: FREE_CHAT_PROMPT,
}

/** Resolve a thread's `agentId` to its {@link Agent}. Unknown / missing
 * ids fall back to {@link DEFAULT_AGENT}. Currently always returns
 * DEFAULT_AGENT — this is the seam where role lookup will plug in. */
export function resolveAgent(_agentId?: string): Agent {
  return DEFAULT_AGENT
}
