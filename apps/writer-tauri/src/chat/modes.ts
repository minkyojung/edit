// The ChatMode table. Lives here rather than inside ModeToggle because two
// call sites need the same order: the dropdown renders it, and the composer's
// Shift+Tab shortcut cycles through it. Restating the order in the shortcut is
// how the two would drift.
//
// Each row maps 1:1 to a ChatMode and to a Claude Agent SDK `PermissionMode`
// (sdk.d.ts); the description states what the host actually does in our
// staged-review architecture, not the raw SDK wording:
//
//   edit        → SDK 'default'      — proposals wait for Keep/Reject
//   acceptEdits → SDK 'acceptEdits'  — proposals auto-apply the instant they land
//   plan        → SDK 'plan'         — read-only; explores + writes a plan, no edits

import { IconHandStop, IconWriting, IconMap, type IconProps } from '@tabler/icons-react'
import type { ComponentType } from 'react'
import type { ChatMode } from '@/chat/types'

export interface ChatModeOption {
  mode: ChatMode
  Icon: ComponentType<IconProps>
  title: string
  /** What the host actually does in this mode (not the raw SDK wording). */
  description: string
}

export const CHAT_MODES: readonly ChatModeOption[] = [
  {
    mode: 'edit',
    Icon: IconHandStop,
    title: 'Ask for approval',
    description: 'Review each edit before applying it',
  },
  {
    mode: 'acceptEdits',
    Icon: IconWriting,
    title: 'Auto-accept edits',
    description: 'Apply every edit automatically, no review',
  },
  {
    mode: 'plan',
    Icon: IconMap,
    title: 'Plan',
    description: 'Read-only — plan without making edits',
  },
]

/**
 * The option to render for `mode`. Legacy threads may carry a mode no longer in
 * CHAT_MODES; those fall back to the first entry — same rule the cycle uses.
 */
export function chatModeOption(mode: ChatMode): ChatModeOption {
  return CHAT_MODES.find((m) => m.mode === mode) ?? CHAT_MODES[0]
}

/**
 * Next mode in the dropdown's own order, wrapping at the end. An unknown mode
 * lands on the first entry (findIndex → -1 → index 0), matching what the
 * dropdown already shows for it.
 */
export function nextChatMode(current: ChatMode): ChatMode {
  const i = CHAT_MODES.findIndex((m) => m.mode === current)
  return CHAT_MODES[(i + 1) % CHAT_MODES.length].mode
}
