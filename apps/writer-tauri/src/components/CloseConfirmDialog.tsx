// The "a chat is in progress — close anyway?" modal, now a pure VIEW over
// useCloseConfirmStore. Both close paths drive it through the store's promise:
//   - editor window X  → useWindowClose (per-window close)
//   - app quit (⌘Q / menu / dock) → the app:close-requested effect below
//
// It also owns the app-QUIT path (not per-window close): flush pending vault
// writes, ask if chats are streaming, then quit. Per-window closes live in
// useWindowClose; this file is only the quit half + the shared dialog.

import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useChatActivity } from '@/stores/chatActivity'
import { useCloseConfirmStore } from '@/state/closeConfirmStore'
import { flushDirty, stopAutoFlush } from '@/lib/docFileSync'
import { useSaveFailureStore } from '@/state/saveFailureStore'
import { stopGitHubSync } from '@/lib/githubSync'

async function quitApp() {
  await flushDirty()
  stopAutoFlush()
  stopGitHubSync()
  invoke('app_quit').catch(() => {})
}

export function CloseConfirmDialog() {
  const open = useCloseConfirmStore((s) => s.open)
  const variant = useCloseConfirmStore((s) => s.variant)
  const count = useCloseConfirmStore((s) => s.count)
  const resolve = useCloseConfirmStore((s) => s.resolve)

  // App-quit path (⌘Q / dock / menu → app:close-requested). Distinct from
  // per-window close: this tears the whole app down.
  useEffect(() => {
    let unlisten: (() => void) | undefined
    listen('app:close-requested', async () => {
      // Flush first so edits typed right before quit reach disk.
      await flushDirty()
      // Data-loss gate: warn only when a write actually FAILED (disk full,
      // vault disconnected, …) — not merely when a slug is still dirty. A
      // slug stays dirty for benign reasons too (external-edit conflict,
      // not-yet-ready view, deferred stale-path write), and those aren't
      // edits quitting would drop. Keying off the failure store keeps the
      // "couldn't be saved" copy honest and never blocks a clean quit.
      const unsaved = useSaveFailureStore.getState().failingSlugCount()
      if (unsaved > 0) {
        const proceed = await useCloseConfirmStore.getState().confirmUnsaved(unsaved)
        if (!proceed) return
      }
      const active = useChatActivity.getState().activeCount
      if (active > 0) {
        const proceed = await useCloseConfirmStore.getState().confirmClose(active)
        if (!proceed) return
      }
      await quitApp()
    }).then((fn) => {
      unlisten = fn
    })
    return () => {
      unlisten?.()
    }
  }, [])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Dismissing (Esc / backdrop) counts as "keep open, don't close".
        if (!next) resolve(false)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {variant === 'unsaved'
              ? "Some changes couldn't be saved"
              : 'A chat is in progress.'}
          </DialogTitle>
          <DialogDescription>
            {variant === 'unsaved'
              ? "Octave can't write to your vault right now (the folder may be disconnected). Quitting now will lose your most recent edits."
              : count === 1
                ? 'Closing now will cancel the response.'
                : `Closing now will cancel ${count} responses in progress.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => resolve(false)} autoFocus>
            {variant === 'unsaved' ? 'Keep app open' : 'Wait'}
          </Button>
          <Button variant="destructive" onClick={() => resolve(true)}>
            {variant === 'unsaved' ? 'Quit anyway' : 'Close anyway'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
