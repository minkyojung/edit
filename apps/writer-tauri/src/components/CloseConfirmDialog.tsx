// Confirmation modal triggered by app:close-requested when one or more
// chats are still streaming. Mounted once at AppShell level.

import { useEffect, useState } from 'react'
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

export function CloseConfirmDialog() {
  const [open, setOpen] = useState(false)
  const activeCount = useChatActivity((s) => s.activeCount)

  useEffect(() => {
    let unlisten: (() => void) | undefined
    listen('app:close-requested', () => {
      // Snapshot the active count at the moment the user tried to quit.
      // Reading the store directly avoids a stale-closure hazard since this
      // callback isn't re-created on every activeCount change.
      const current = useChatActivity.getState().activeCount
      if (current > 0) {
        setOpen(true)
      } else {
        // Nothing in flight — quit immediately.
        invoke('app_quit').catch(() => {})
      }
    }).then((fn) => {
      unlisten = fn
    })
    return () => {
      unlisten?.()
    }
  }, [])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
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
          <Button variant="outline" onClick={() => setOpen(false)} autoFocus>
            Wait
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              invoke('app_quit').catch(() => {})
            }}
          >
            Cancel and Quit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
