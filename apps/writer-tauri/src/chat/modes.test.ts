// Pins the cycle Shift+Tab drives. The sequence is spelled out rather than
// derived from CHAT_MODES: deriving it would just restate the implementation
// and could not fail. A stride that skips a mode still visits all three (3 is
// prime), so only the literal sequence catches it. Reordering the dropdown is
// allowed — it just has to be a deliberate edit here too.

import { describe, expect, it } from 'vitest'
import { CHAT_MODES, chatModeOption, nextChatMode } from './modes'
import type { ChatMode } from './types'

describe('nextChatMode', () => {
  it('steps to the adjacent mode and wraps at the end', () => {
    expect(nextChatMode('edit')).toBe('acceptEdits')
    expect(nextChatMode('acceptEdits')).toBe('plan')
    expect(nextChatMode('plan')).toBe('edit')
  })

  it('runs in the order the dropdown lists — the cycle is the table, top to bottom', () => {
    // If these disagree, Shift+Tab jumps around a menu the user is reading.
    const cycled: ChatMode[] = []
    let cur = CHAT_MODES[0].mode
    for (let i = 0; i < CHAT_MODES.length; i++) {
      cycled.push(cur)
      cur = nextChatMode(cur)
    }
    expect(cycled).toEqual(CHAT_MODES.map((m) => m.mode))
  })

  it('lands an unknown mode on the first entry — the one the dropdown shows for it', () => {
    // A legacy thread persisted a mode that no longer exists.
    const stale = 'bypassPermissions' as ChatMode
    expect(nextChatMode(stale)).toBe(CHAT_MODES[0].mode)
    expect(chatModeOption(stale)).toBe(CHAT_MODES[0])
  })
})

describe('CHAT_MODES', () => {
  it('carries every ChatMode, so the cycle can reach all of them', () => {
    // Adding a member to the ChatMode union without a row here is a type error
    // on this literal — that is the check. A mode missing from the table is
    // unreachable by both the dropdown and Shift+Tab.
    const everyMode: Record<ChatMode, true> = {
      edit: true,
      acceptEdits: true,
      plan: true,
    }
    expect(CHAT_MODES.map((m) => m.mode).sort()).toEqual(Object.keys(everyMode).sort())
  })
})
