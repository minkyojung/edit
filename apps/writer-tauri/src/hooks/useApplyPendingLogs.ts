// Lazy drainer for ingest log entries — when the user navigates to
// wiki:log with queued log lines, this hook appends them to the page.
//
// Used to also stamp proofSuggestion marks for wiki proposals on
// other wiki:* pages; that path is gone (see layout/WikiPageBanner.tsx
// for the replacement — in-page inbox, no marks). This hook now
// handles only the log drain.
//
// Why lazy: applyPendingLogsForView needs an EditorView, and only
// one wiki page is mounted at a time. Materializing on navigate
// means log entries land the moment the user arrives at wiki:log.
//
// Why we wait for provider.isSynced / idb.synced before dispatching:
// MilkdownEditor's onViewReady fires immediately after the editor
// is created — before y-prosemirror has finished reconciling the
// ydoc's content into the PM doc. Dispatching during that window
// inserts into an empty PM doc that the reconciliation a moment
// later rebuilds from the (real) ydoc state — our write vanishes.
// Either signal is sufficient: idb hydrate restores the same Y.Doc
// the server would have sent, so a wiki:log can drain offline.
//
// Mounted once at App root. Subscribes to active slug + global view;
// fires when both are ready and the active doc is wiki:log with
// pending log entries.

import { useEffect, useRef } from 'react'
import { useDocsStore } from '@/state/docsStore'
import { useEditorViewStore } from '@/state/editorViewStore'
import { useIngestStore } from '@/state/ingestStore'
import { applyPendingLogsForView } from '@/agent/applyIngest'

function waitForLocalReady(handle: {
  provider: {
    isSynced: boolean
    on: (e: 'synced', f: () => void) => void
    off: (e: 'synced', f: () => void) => void
  } | null
  idb: {
    synced: boolean
    on: (e: 'synced', f: () => void) => void
    off: (e: 'synced', f: () => void) => void
  }
}): Promise<void> {
  return new Promise<void>((resolve) => {
    const finish = () => setTimeout(resolve, 50)
    if (handle.provider?.isSynced || handle.idb.synced) {
      finish()
      return
    }
    const onAny = () => {
      handle.provider?.off('synced', onAny)
      handle.idb.off('synced', onAny)
      finish()
    }
    handle.provider?.on('synced', onAny)
    handle.idb.on('synced', onAny)
  })
}

export function useApplyPendingLogs(): void {
  const activeSlug = useDocsStore((s) => s.activeSlug)
  const handles = useDocsStore((s) => s.handles)
  const view = useEditorViewStore((s) => s.view)
  const pendingLogs = useIngestStore((s) => s.pendingLogs)

  const lastAttemptRef = useRef<string | null>(null)
  const runningRef = useRef(false)

  useEffect(() => {
    if (!activeSlug || !view || runningRef.current) return
    const known = useDocsStore
      .getState()
      .knownDocs.find((d) => d.slug === activeSlug)
    if (!known || known.type !== 'wiki:log') return
    const handle = handles[activeSlug]
    if (!handle) return
    if (pendingLogs.length === 0) return

    const signature = `log:${pendingLogs.map((l) => l.id).sort().join(',')}`
    if (lastAttemptRef.current === signature) return
    lastAttemptRef.current = signature
    runningRef.current = true
    void waitForLocalReady(handle)
      .then(() => {
        // Re-read latest view in case the editor remounted while we
        // were waiting for sync (user clicked away and back).
        const liveView = useEditorViewStore.getState().view
        if (!liveView) return
        applyPendingLogsForView(liveView)
      })
      .catch((err) => console.warn('[ingest] applyPendingLogs failed', err))
      .finally(() => {
        runningRef.current = false
      })
  }, [activeSlug, view, handles, pendingLogs])
}
