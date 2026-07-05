// Imperative confirm dialog — `await confirm({ ... })` returns a promise that
// resolves true (confirmed) / false (cancelled or dismissed). One host
// (<ConfirmDialogHost/>, mounted once at app root) renders the actual dialog,
// so callers don't each carry open-state + a Dialog. Used by the delete
// affordances (list pages + the note ⋯ menu), reusable anywhere a yes/no gate
// is needed.

import { create } from 'zustand'

export interface ConfirmOptions {
  title: string
  description?: string
  /** Confirm-button label (default "Delete"). */
  confirmLabel?: string
  /** Style the confirm button as destructive (default true — the only caller
   * today is delete). */
  destructive?: boolean
}

interface ConfirmState {
  open: boolean
  options: ConfirmOptions | null
  resolve: ((ok: boolean) => void) | null
  confirm: (options: ConfirmOptions) => Promise<boolean>
  /** Host-only: settle the pending promise and close. */
  settle: (ok: boolean) => void
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  open: false,
  options: null,
  resolve: null,
  confirm: (options) =>
    new Promise<boolean>((resolve) => {
      // If a prior confirm is somehow still open, reject it as cancelled so
      // its awaiter unblocks before we replace it.
      get().resolve?.(false)
      set({ open: true, options, resolve })
    }),
  settle: (ok) => {
    get().resolve?.(ok)
    set({ open: false, resolve: null })
  },
}))

/** Ask the user to confirm. Resolves true only on explicit confirm. */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return useConfirmStore.getState().confirm(options)
}
