// Confirmation modal triggered by app:close-requested when one or more
// chats are still streaming. Mounted once at AppShell level.
//
// Also runs the vault auto-flush pipeline before any quit path so
// unsaved edits (and any made during the confirm dialog) reach disk.
// Without this, edits in the last 2 seconds before quit could be
// lost: the auto-flush timer runs at most every 2s, and a user
// typing right before Cmd+Q could fall in that window.

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
import { flushDirty, stopAutoFlush } from '@/lib/docFileSync'
import { stopGitHubSync } from '@/lib/githubSync'

export function CloseConfirmDialog() {
  const [open, setOpen] = useState(false)
  const activeCount = useChatActivity((s) => s.activeCount)

  useEffect(() => {
    let unlisten: (() => void) | undefined
    listen('app:close-requested', async () => {
      // Best-effort flush of pending vault writes BEFORE we decide
      // what to do next. Catches the typing-just-before-quit window
      // where dirty slugs haven't reached the 2s timer yet. The
      // flush is fast (~200ms typical for a single doc) so this
      // doesn't measurably delay the close dialog or the quit path.
      await flushDirty()

      // Snapshot the active count at the moment the user tried to quit.
      // Reading the store directly avoids a stale-closure hazard since this
      // callback isn't re-created on every activeCount change.
      const current = useChatActivity.getState().activeCount
      if (current > 0) {
        setOpen(true)
      } else {
        // Nothing in flight — quit immediately. Stop the flush timer
        // so it doesn't keep ticking against a torn-down store
        // during the brief window before the process exits.
        stopAutoFlush()
        stopGitHubSync()
        invoke('app_quit').catch(() => {})
      }
    }).then((fn) => {
      unlisten = fn
    })
    return () => {
      unlisten?.()
    }
  }, [])

  // Final flush + stop before the user confirms a quit-with-chats-
  // in-flight. The dialog can stay open for arbitrary time; edits
  // made while it's up should still land on disk.
  const confirmQuit = async () => {
    await flushDirty()
    stopAutoFlush()
    stopGitHubSync()
    invoke('app_quit').catch(() => {})
  }

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
              void confirmQuit()
            }}
          >
            Cancel and Quit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
