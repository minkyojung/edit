// FileViewer — full-area surface (route `/file/:rel`) that renders a
// non-markdown vault file (pdf/image/audio/video/text) natively inside the
// app, instead of bouncing the user out to Finder. Read-only: there's no
// editor, no slug, no Yjs doc — the file is identified purely by its
// vault-relative path (the route param).
//
// Media loads through Tauri's asset protocol (convertFileSrc), the same
// path the editor already uses for inline images/video. Text is read as
// bytes and decoded. Anything unrecognised falls back to open-in-default.

import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { IconExternalLink, IconFile } from '@tabler/icons-react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { openVaultFile, readVaultBinary, vaultAbsPath } from '@/lib/vault'
import { classifyAsset } from '@/lib/attachments'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

// Title + Open action shown in the EditorHeader's center slot while a
// file route is active (rendered by EditorHeader, not here) — keeps the
// file's chrome on the shared header row between the nav arrows and the
// doc-actions menu, instead of in a second bar of its own.
export function FileViewerHeaderTitle({ rel }: { rel: string }) {
  const fileName = rel.split('/').pop() ?? rel
  const openExternal = () =>
    void openVaultFile(rel).catch((err) =>
      console.warn('[file] open in default app failed', err),
    )
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-2">
      <IconFile size={14} stroke={1.75} className="shrink-0 text-muted-foreground" />
      <span className="truncate text-sm font-medium text-foreground" title={rel}>
        {fileName}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={openExternal}
            aria-label="Open in default app"
            className="shrink-0 text-sidebar-foreground/60 hover:text-sidebar-foreground"
          >
            <IconExternalLink size={14} stroke={1.75} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Open in default app</TooltipContent>
      </Tooltip>
    </div>
  )
}

export function FileViewer() {
  // react-router v7 useParams returns the decoded value, so the
  // encodeURIComponent the sidebar applied is already reversed here.
  const rel = useParams().rel ?? ''
  const kind = classifyAsset(rel)
  const fileName = rel.split('/').pop() ?? rel

  // Asset URL for media (convertFileSrc) OR decoded text for text files.
  const [assetUrl, setAssetUrl] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setAssetUrl(null)
    setText(null)
    setFailed(false)
    void (async () => {
      try {
        if (kind === 'text') {
          const bytes = await readVaultBinary(rel)
          if (!cancelled) setText(new TextDecoder().decode(bytes))
        } else if (kind !== 'other') {
          const abs = await vaultAbsPath(rel)
          if (!cancelled) setAssetUrl(convertFileSrc(abs))
        }
      } catch (err) {
        console.error('[file] load failed', { rel, err })
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [rel, kind])

  const openExternal = () =>
    void openVaultFile(rel).catch((err) =>
      console.warn('[file] open in default app failed', err),
    )

  return (
    // pt clears the absolutely-positioned EditorHeader AppShell overlays.
    // The filename + Open action live in EditorHeader (FileViewerHeaderTitle),
    // so this surface is just the preview area.
    <div className="flex h-full flex-col pt-[var(--header-h)]">
      <div className="min-h-0 flex-1 overflow-auto bg-muted/30">
        {failed ? (
          <Fallback
            message="This file couldn't be loaded."
            onOpen={openExternal}
          />
        ) : kind === 'image' && assetUrl ? (
          <img
            src={assetUrl}
            alt={fileName}
            className="mx-auto block max-h-full max-w-full object-contain p-4"
          />
        ) : kind === 'pdf' && assetUrl ? (
          <iframe src={assetUrl} title={fileName} className="h-full w-full border-0" />
        ) : kind === 'video' && assetUrl ? (
          <video
            src={assetUrl}
            controls
            className="mx-auto block max-h-full max-w-full p-4"
          />
        ) : kind === 'audio' && assetUrl ? (
          <div className="flex h-full items-center justify-center p-6">
            <audio src={assetUrl} controls className="w-full max-w-md" />
          </div>
        ) : kind === 'text' && text !== null ? (
          <pre className="whitespace-pre-wrap break-words p-4 font-mono text-sm text-foreground">
            {text}
          </pre>
        ) : kind === 'other' ? (
          <Fallback
            message="This file type can't be previewed in the app."
            onOpen={openExternal}
          />
        ) : (
          // Loading (media/text not ready yet).
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading…
          </div>
        )}
      </div>
    </div>
  )
}

function Fallback({ message, onOpen }: { message: string; onOpen: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <button
        type="button"
        onClick={onOpen}
        className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
      >
        <IconExternalLink size={15} stroke={1.75} />
        Open in default app
      </button>
    </div>
  )
}
