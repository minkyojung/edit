// Lazy drainer for system-page queues — one hook covers every queue
// that materializes "on first navigation to the matching page."
//
// Previously two near-identical hooks (useApplyPendingLogs +
// useApplyPendingIndexUpdates) ran the same drain protocol against
// different queues and apply functions. They differed only in three
// places (target type id, queue selector, apply function), so the
// abstraction is:
//
//   useLazyMaterialize([
//     { matchType: 'system:log',   queueSelector: ..., applyForView: ... },
//     { matchType: 'system:index', queueSelector: ..., applyForView: ... },
//   ])
//
// Adding a new system page that drains on navigation (system:about,
// system:lint, …) is now a single config row.
//
// Why lazy: applyXxxForView needs an EditorView, and only one wiki
// page is mounted at a time. Materializing on navigate means
// entries land the moment the user arrives at the target page.
//
// Why we wait for provider.isSynced / idb.synced before dispatching:
// MilkdownEditor's onViewReady fires immediately after the editor
// is created — before y-prosemirror has finished reconciling the
// ydoc's content into the PM doc. Dispatching during that window
// inserts into an empty PM doc that the reconciliation a moment
// later rebuilds from the (real) ydoc state — our write vanishes.
// Either sync signal is sufficient: idb hydrate restores the same
// Y.Doc the server would have sent, so drains succeed offline.
//
// Mounted once at App root. Subscribes to active slug + global view
// + each queue; fires the matching config when active doc / view /
// handle / queue are all ready.

import { useEffect, useRef } from 'react'
import type { EditorView } from '@milkdown/kit/prose/view'
import { useDocsStore, type KnownDoc } from '@/state/docsStore'
import { useActiveSlug } from '@/hooks/useActiveSlug'
import { useEditorViewStore } from '@/state/editorViewStore'
import { useIngestStore } from '@/state/ingestStore'

type IngestState = ReturnType<typeof useIngestStore.getState>

export interface LazyMaterializeConfig {
  /** Doc type to match against the active doc. The config's apply
   * runs only when the user is on a doc of this type. */
  matchType: KnownDoc['type']
  /** Selector for the queue this config drains. Must return a stable
   * array reference between renders (zustand's selector identity
   * checks). Re-fetched on every render of the hook. */
  queueSelector: (state: IngestState) => Array<{ id: string }>
  /** Drain function. Called with the live view once IDB / provider
   * has hydrated. Should remove its consumed entries from the queue
   * itself — this hook is purely a dispatcher. */
  applyForView: (view: EditorView) => unknown
  /** Short identifier for the signature ref + warn logs. Keeps
   * multiple configs from confusing each other's single-flight
   * state. Pick something distinct per config. */
  signaturePrefix: string
}

function waitForLocalReady(handle: {
  contentReady: Promise<void>
}): Promise<void> {
  // Small post-resolution delay so y-prosemirror's initial PM↔Y
  // reconcile finishes its microtask flush before the caller starts
  // walking the doc. Same 50ms cushion the previous IDB-event path
  // used — empirical, kept identical so timing-sensitive consumers
  // (system page drain) don't observe a different paint cadence.
  return handle.contentReady.then(
    () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
  )
}

/** Hook variant for a single config. Internal use only — the public
 * `useLazyMaterialize` below is the caller-facing API that takes an
 * array. Splitting them out is what lets the array form satisfy
 * the Rules of Hooks: each config gets its own stable hook call
 * because we iterate the array directly inside a parent hook
 * (configs.length must be constant across renders — see the public
 * function's contract below). */
function useLazyDrain(config: LazyMaterializeConfig): void {
  const activeSlug = useActiveSlug()
  const handles = useDocsStore((s) => s.handles)
  const view = useEditorViewStore((s) => s.view)
  const queue = useIngestStore(config.queueSelector)

  const lastAttemptRef = useRef<string | null>(null)
  const runningRef = useRef(false)

  useEffect(() => {
    if (!activeSlug || !view || runningRef.current) return
    const known = useDocsStore
      .getState()
      .knownDocs.find((d) => d.slug === activeSlug)
    if (!known || known.type !== config.matchType) return
    const handle = handles[activeSlug]
    if (!handle) return
    if (queue.length === 0) return

    const signature = `${config.signaturePrefix}:${queue
      .map((q) => q.id)
      .sort()
      .join(',')}`
    if (lastAttemptRef.current === signature) return
    lastAttemptRef.current = signature
    runningRef.current = true
    void waitForLocalReady(handle)
      .then(() => {
        // Re-read latest view in case the editor remounted while we
        // were waiting for sync (user clicked away and back).
        const liveView = useEditorViewStore.getState().view
        if (!liveView) return
        config.applyForView(liveView)
      })
      .catch((err) =>
        console.warn(`[ingest:${config.signaturePrefix}] drain failed`, err),
      )
      .finally(() => {
        runningRef.current = false
      })
  }, [activeSlug, view, handles, queue, config])
}

/** Mount one drain pipeline per config. The configs array MUST be
 * stable across renders (length never changes — the rules of hooks
 * forbid conditional hook calls). Pass it as a module-scope
 * constant, not an inline literal that re-creates each render. */
export function useLazyMaterialize(configs: LazyMaterializeConfig[]): void {
  for (const config of configs) {
    // Iteration order is stable because configs.length is fixed by
    // the caller contract above; each config gets one consistent
    // hook call slot across renders. The for-of expansion is what
    // React's rules-of-hooks rule wants — a constant number of
    // hook calls in the same order — so this is safe in practice
    // even though the call site looks like a loop.
    useLazyDrain(config)
  }
}
