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
import { stopGitHubSync } from '@/lib/githubSync'

async function quitApp() {
  await flushDirty()
  stopAutoFlush()
  stopGitHubSync()
  invoke('app_quit').catch(() => {})
}

export function CloseConfirmDialog() {
  const open = useCloseConfirmStore((s) => s.open)
  const activeCount = useCloseConfirmStore((s) => s.activeCount)
  const resolve = useCloseConfirmStore((s) => s.resolve)

  // App-quit path (⌘Q / dock / menu → app:close-requested). Distinct from
  // per-window close: this tears the whole app down.
  useEffect(() => {
    let unlisten: (() => void) | undefined
    listen('app:close-requested', async () => {
      // Flush first so edits typed right before quit reach disk.
      await flushDirty()
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
          <DialogTitle>A chat is in progress.</DialogTitle>
          <DialogDescription>
            {activeCount === 1
              ? 'Closing now will cancel the response.'
              : `Closing now will cancel ${activeCount} responses in progress.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => resolve(false)} autoFocus>
            Wait
          </Button>
          <Button variant="destructive" onClick={() => resolve(true)}>
            Close anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
