// Promise-based "confirm closing while chats stream" dialog state.
//
// The close coordinator (useWindowClose) and the app-quit path both need to
// ASK the user and await the answer inline: `if (!await confirmClose(n)) return`.
// A plain event/dialog can't be awaited, so this store bridges the modal to a
// promise — confirmClose() opens the dialog and resolves when the user picks
// Wait (false) or Close (true). Transient; never persisted.

import { create } from 'zustand'

interface CloseConfirmState {
  open: boolean
  /** How many chats are in flight — drives the dialog copy. */
  activeCount: number
  _resolve: ((proceed: boolean) => void) | null
  /** Open the dialog and resolve true (proceed to close) / false (keep open).
   * If a confirm is already pending, the previous one resolves false first so
   * there's never a dangling promise. */
  confirmClose: (activeCount: number) => Promise<boolean>
  /** Called by the dialog buttons (and on dismiss) to settle the promise. */
  resolve: (proceed: boolean) => void
}

export const useCloseConfirmStore = create<CloseConfirmState>((set, get) => ({
  open: false,
  activeCount: 0,
  _resolve: null,
  confirmClose: (activeCount) => {
    get()._resolve?.(false)
    return new Promise<boolean>((resolve) => {
      set({ open: true, activeCount, _resolve: resolve })
    })
  },
  resolve: (proceed) => {
    const r = get()._resolve
    set({ open: false, _resolve: null })
    r?.(proceed)
  },
}))
