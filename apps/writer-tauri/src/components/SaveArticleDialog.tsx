// Save-to-Read-Later dialog. URL field → saveArticleFromUrl → close.
// Outcome (success/failure) is surfaced via toast by the orchestration
// (notify.articleSaved / articleSaveFailed), so the dialog itself only
// drives the input + a running spinner, and stays open on failure so
// the user can fix the URL and retry.

import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { saveArticleFromUrl } from '@/lib/saveArticle'
import { parseYoutubeId } from '@/lib/youtube'
import { useSaveArticleDialogStore } from '@/state/saveArticleDialogStore'

export function SaveArticleDialog() {
  const open = useSaveArticleDialogStore((s) => s.open)
  const close = useSaveArticleDialogStore((s) => s.close)
  const [url, setUrl] = useState('')
  const [saving, setSaving] = useState(false)

  const reset = () => {
    setUrl('')
    setSaving(false)
  }

  const handleClose = () => {
    reset()
    close()
  }

  const handleSave = async () => {
    const trimmed = url.trim()
    if (!trimmed || saving) return
    setSaving(true)
    const res = await saveArticleFromUrl(trimmed)
    setSaving(false)
    // Success → close (toast confirms). Failure → stay open, keep the
    // URL so the user can fix it (toast explains why).
    if (res.ok) handleClose()
  }

  const canSave = url.trim().length > 0 && !saving
  const isYoutube = parseYoutubeId(url.trim()) !== null

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Don't let an outside-click / Esc dismiss mid-save.
        if (!next && !saving) handleClose()
      }}
    >
      <DialogContent
        className="sm:max-w-[480px]"
        onEscapeKeyDown={(e) => {
          if (saving) e.preventDefault()
        }}
        onPointerDownOutside={(e) => {
          if (saving) e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>Add to Inbox</DialogTitle>
          <DialogDescription>
            Paste an article or YouTube link — we'll capture it into your inbox.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Input
            autoFocus
            placeholder="https://… (article or YouTube)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSave) void handleSave()
            }}
            disabled={saving}
          />
          {isYoutube && (
            <p className="text-footnote text-muted-foreground">
              🎬 YouTube detected — we'll capture the transcript.
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={handleClose} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void handleSave()} disabled={!canSave}>
              {saving && <Spinner className="size-4" />}
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
