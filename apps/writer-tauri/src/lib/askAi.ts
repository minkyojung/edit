// Ask AI: leave the compact panel and land in the full editor with chat open
// + focused. The note being written is the active doc, so the agent already
// has it in context — no explicit attach needed. Shared by the compact header
// action and the bottom Ask AI pill so they never drift.

import { useLayoutStore } from '@/state/layoutStore'
import { useWindowModeStore } from '@/state/windowModeStore'

export function askAi() {
  useLayoutStore.getState().openRightPanelInMode('chat')
  void useWindowModeStore.getState().toggle() // compact → full
  useLayoutStore.getState().requestChatInputFocus()
}
