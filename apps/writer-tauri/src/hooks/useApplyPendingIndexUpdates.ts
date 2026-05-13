// Lazy drainer for ingest index updates — when the user navigates
// to wiki:index with queued summary lines, this hook merges them
// into the page. Mirrors useApplyPendingLogs but with dedup-merge
// semantics (one line per page, replace-in-place keyed by target).
//
// Why lazy: applyPendingIndexUpdatesForView needs an EditorView,
// and only one wiki page is mounted at a time. Materializing on
// navigate means summaries land the moment the user arrives at
// wiki:index.
//
// Why we wait for provider.isSynced / idb.synced before dispatching:
// MilkdownEditor's onViewReady fires immediately after the editor
// is created — before y-prosemirror has finished reconciling the
// ydoc's content into the PM doc. Dispatching during that window
// merges into an empty PM doc that reconciliation then rebuilds
// from the (real) ydoc state — our writes vanish. Either signal
// is sufficient: idb hydrate restores the same Y.Doc the server
// would have sent, so a wiki:index can drain offline.
//
// Mounted once at App root.

import { useEffect, useRef } from 'react'
import { useDocsStore } from '@/state/docsStore'
import { useEditorViewStore } from '@/state/editorViewStore'
import { useIngestStore } from '@/state/ingestStore'
import { applyPendingIndexUpdatesForView } from '@/agent/applyIngest'

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

export function useApplyPendingIndexUpdates(): void {
  const activeSlug = useDocsStore((s) => s.activeSlug)
  const handles = useDocsStore((s) => s.handles)
  const view = useEditorViewStore((s) => s.view)
  const pendingIndexUpdates = useIngestStore((s) => s.pendingIndexUpdates)

  const lastAttemptRef = useRef<string | null>(null)
  const runningRef = useRef(false)

  useEffect(() => {
    if (!activeSlug || !view || runningRef.current) return
    const known = useDocsStore
      .getState()
      .knownDocs.find((d) => d.slug === activeSlug)
    if (!known || known.type !== 'wiki:index') return
    const handle = handles[activeSlug]
    if (!handle) return
    if (pendingIndexUpdates.length === 0) return

    const signature = `idx:${pendingIndexUpdates.map((u) => u.id).sort().join(',')}`
    if (lastAttemptRef.current === signature) return
    lastAttemptRef.current = signature
    runningRef.current = true
    void waitForLocalReady(handle)
      .then(() => {
        const liveView = useEditorViewStore.getState().view
        if (!liveView) return
        applyPendingIndexUpdatesForView(liveView)
      })
      .catch((err) =>
        console.warn('[ingest:index] applyPendingIndexUpdates failed', err),
      )
      .finally(() => {
        runningRef.current = false
      })
  }, [activeSlug, view, handles, pendingIndexUpdates])
}
