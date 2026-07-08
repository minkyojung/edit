// Promise-based "confirm closing while chats stream" dialog state.
//
// The close coordinator (useWindowClose) and the app-quit path both need to
// ASK the user and await the answer inline: `if (!await confirmClose(n)) return`.
// A plain event/dialog can't be awaited, so this store bridges the modal to a
// promise — confirmClose() opens the dialog and resolves when the user picks
// Wait (false) or Close (true). Transient; never persisted.

import { create } from 'zustand'

/** Why we're asking before closing:
 *   - 'chat'    → a response is streaming and would be cancelled
 *   - 'unsaved' → the final flush failed, so quitting loses recent edits */
export type CloseConfirmVariant = 'chat' | 'unsaved'

interface CloseConfirmState {
  open: boolean
  variant: CloseConfirmVariant
  /** For 'chat': chats in flight. For 'unsaved': notes that failed to save.
   * Drives the dialog copy. */
  count: number
  _resolve: ((proceed: boolean) => void) | null
  /** Open the "chats are streaming" confirm. Resolves true (proceed to
   * close) / false (keep open). If a confirm is already pending, the
   * previous one resolves false first so there's never a dangling promise. */
  confirmClose: (activeCount: number) => Promise<boolean>
  /** Open the "changes couldn't be saved" confirm (quit-time data-loss
   * gate). Same promise contract as confirmClose. */
  confirmUnsaved: (count: number) => Promise<boolean>
  /** Called by the dialog buttons (and on dismiss) to settle the promise. */
  resolve: (proceed: boolean) => void
}

export const useCloseConfirmStore = create<CloseConfirmState>((set, get) => ({
  open: false,
  variant: 'chat',
  count: 0,
  _resolve: null,
  confirmClose: (activeCount) => {
    get()._resolve?.(false)
    return new Promise<boolean>((resolve) => {
      set({ open: true, variant: 'chat', count: activeCount, _resolve: resolve })
    })
  },
  confirmUnsaved: (count) => {
    get()._resolve?.(false)
    return new Promise<boolean>((resolve) => {
      set({ open: true, variant: 'unsaved', count, _resolve: resolve })
    })
  },
  resolve: (proceed) => {
    const r = get()._resolve
    set({ open: false, _resolve: null })
    r?.(proceed)
  },
}))
