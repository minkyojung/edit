// FREE_CHAT_PROMPT — the default chat persona body.
//
// The content itself now lives in the bundled default agent file
// `agent/defaults/agents/default.md` (one source of truth, seeded into the
// vault at boot as `_system/agent/agents/default.md`). This module just
// surfaces that same body as a constant for `resolveAgent`'s fallback — used
// when the vault's `default.md` is missing/unreadable.
//
// Anatomy of the system prompt the chat runner assembles:
//   1. SELF PROFILE   (wiki:profile body)
//   2. CLAUDE.md      (vault schema + conventions)
//   3. FREE_CHAT_PROMPT  ← default.md body
//   4. (cache boundary)
//   5. DOCUMENT       (current editor body)

import { DEFAULT_AGENTS } from '@/agent/defaults'

export const FREE_CHAT_PROMPT =
  DEFAULT_AGENTS.find((a) => a.name === 'default')?.body ?? ''
