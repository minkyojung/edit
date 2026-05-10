// Lazy materializer for ingest proposals — when the user navigates
// to a wiki:* page that has queued proposals, this hook stamps them
// as proofSuggestion marks in the now-active editor. Marks are
// reviewed in-context via the existing MarkPopoverLayer.
//
// Why lazy: applyProposal needs an EditorView, and only one wiki
// page is mounted at a time. Materializing on navigate means the
// user sees marks the moment they arrive at the page they were
// asked to review — and proposals for other pages stay queued
// until those pages are navigated to.
//
// Why we wait for provider.isSynced before dispatching:
// MilkdownEditor's onViewReady fires immediately after the editor
// is created — before y-prosemirror has finished reconciling the
// ydoc's content into the PM doc. If we dispatch a PM transaction
// during that window, our insert lands in an empty PM doc, the
// reconciliation a moment later rebuilds PM from the (real) ydoc
// state, and our write vanishes from view. We saw exactly that:
// log lines appearing briefly and disappearing ~1s later.
// Waiting for `provider.isSynced` guarantees the initial server
// snapshot has arrived; waiting one extra tick gives y-prosemirror
// time to project that state into PM. After both, dispatches are
// durable.
//
// Mounted once at App root. Subscribes to active slug + global view;
// fires when both are ready and the active doc is a wiki:* type
// with matching queued proposals. Includes a cycle guard so a
// successful apply (which clears the queue) doesn't immediately
// re-fire on the next render.

import { useEffect, useRef } from 'react'
import { useDocsStore } from '@/state/docsStore'
import { useEditorViewStore } from '@/state/editorViewStore'
import { useIngestStore } from '@/state/ingestStore'
import { applyPendingForActive, applyPendingLogsForView } from '@/agent/applyIngest'

/** Resolve when the provider's initial sync is done AND y-prosemirror
 * has had a tick to project the ydoc into the PM view. Without this
 * gate, PM transactions dispatched on a freshly-mounted view land on
 * an empty doc that gets rebuilt out from under them when sync
 * completes — the local edits silently vanish. */
function waitForSync(
  provider: { isSynced: boolean; on: (e: 'synced', f: () => void) => void; off: (e: 'synced', f: () => void) => void },
): Promise<void> {
  return new Promise<void>((resolve) => {
    const finish = () => setTimeout(resolve, 50)
    if (provider.isSynced) {
      finish()
      return
    }
    const onSynced = () => {
      provider.off('synced', onSynced)
      finish()
    }
    provider.on('synced', onSynced)
  })
}

export function useApplyPendingMarks(): void {
  const activeSlug = useDocsStore((s) => s.activeSlug)
  const handles = useDocsStore((s) => s.handles)
  const view = useEditorViewStore((s) => s.view)
  const pendingProposals = useIngestStore((s) => s.pendingProposals)
  const pendingLogs = useIngestStore((s) => s.pendingLogs)

  // Track which (slug, queueSize) combinations we've already tried so
  // a single navigation doesn't re-trigger every render. We bump the
  // signature when proposals are added later (so a fresh batch on the
  // same active page still gets picked up).
  const lastAttemptRef = useRef<string | null>(null)
  // Coarse single-flight: don't run a second apply while the first
  // is still in flight (anchor seed + N applies).
  const runningRef = useRef(false)

  useEffect(() => {
    if (!activeSlug || !view || runningRef.current) return
    const known = useDocsStore
      .getState()
      .knownDocs.find((d) => d.slug === activeSlug)
    if (!known || !known.type.startsWith('wiki:')) return
    const handle = handles[activeSlug]
    if (!handle) return

    // wiki:log gets the log-flush path (raw text appends via PM tr),
    // every other wiki:* gets the marks path (proofSuggestion via
    // applyProposal). We dispatch on type up front and bail when
    // there's nothing matching for either path.
    if (known.type === 'wiki:log') {
      if (pendingLogs.length === 0) return
      const signature = `log:${pendingLogs.map((l) => l.id).sort().join(',')}`
      if (lastAttemptRef.current === signature) return
      lastAttemptRef.current = signature
      runningRef.current = true
      void waitForSync(handle.provider)
        .then(() => {
          // Re-read latest view in case the editor remounted while
          // we were waiting for sync (user clicked away and back).
          const liveView = useEditorViewStore.getState().view
          if (!liveView) return
          applyPendingLogsForView(liveView)
        })
        .catch((err) => console.warn('[ingest] applyPendingLogs failed', err))
        .finally(() => {
          runningRef.current = false
        })
      return
    }

    const matching = pendingProposals.filter((p) => p.target === known.type)
    if (matching.length === 0) return

    // Signature includes the queue's current ids so a brand-new
    // proposal that lands while the user is already on the target
    // page still triggers another apply.
    const signature = `${activeSlug}:${matching.map((p) => p.id).sort().join(',')}`
    if (lastAttemptRef.current === signature) return
    lastAttemptRef.current = signature

    console.log('[ingest:materialize] scheduling apply', {
      activeSlug,
      type: known.type,
      matching: matching.length,
      proposalIds: matching.map((p) => p.id),
    })
    runningRef.current = true
    void waitForSync(handle.provider)
      .then(() => {
        const liveView = useEditorViewStore.getState().view
        if (!liveView) {
          console.warn('[ingest:materialize] no liveView after sync')
          return
        }
        return applyPendingForActive(liveView, known.type)
      })
      .catch((err) => console.warn('[ingest:materialize] applyPendingForActive failed', err))
      .finally(() => {
        runningRef.current = false
      })
  }, [activeSlug, view, handles, pendingProposals, pendingLogs])
}
