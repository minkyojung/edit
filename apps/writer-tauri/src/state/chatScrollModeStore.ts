// Chat auto-scroll behaviour, toggleable so the two canonical patterns can
// be compared side by side in the same conversation:
//
//   'follow'  — stick-to-bottom. The transcript keeps the newest content in
//               view while the answer streams (KakaoTalk-style). This is the
//               long-standing behaviour and stays the default.
//   'anchor'  — anchor-to-top (ChatGPT/Claude-style). On send, the message you
//               just wrote jumps to the top of the viewport and stays pinned
//               there while the reply streams into the space below it.
//
// A per-device UI preference, so it lives in localStorage namespaced per
// project window like the other view-state stores.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { projectStorageKey } from '@/lib/windowRoot'

export type ChatScrollMode = 'follow' | 'anchor'

interface ChatScrollModeState {
  mode: ChatScrollMode
  toggle: () => void
}

export const useChatScrollMode = create<ChatScrollModeState>()(
  persist(
    (set) => ({
      mode: 'follow',
      toggle: () => set((s) => ({ mode: s.mode === 'follow' ? 'anchor' : 'follow' })),
    }),
    { name: projectStorageKey('writer-tauri:chat-scroll-mode') },
  ),
)
