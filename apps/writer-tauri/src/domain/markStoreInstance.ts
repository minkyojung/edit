/**
 * The runtime markStore singleton.
 *
 * Wires the dependency-injected factory in `markStoreImpl` to the
 * app's actual runtime state: the active EditorView lives in
 * `useEditorViewStore`, the per-doc Y.Doc handles live in
 * `useDocsStore`. The factory pattern keeps the domain layer testable
 * (tests instantiate their own markStore with fixtures) while this
 * file gives the rest of the app one place to import `markStore`
 * from.
 *
 * Runtime constraint:
 *   The editor mounts ONE EditorView for the active doc — switching
 *   docs unmounts and remounts. So `getHandle(slug)` can only return
 *   a usable handle when `slug === activeSlug`. Calls for a non-active
 *   doc receive null and surface `view_not_ready` to the caller.
 *
 *   The implication: long-running async flows (e.g. an ingest pass
 *   that produces a proposal seconds after the user switched docs)
 *   may land on a non-active slug. Callers that need to write to a
 *   non-active doc must queue and replay (this is exactly the wiki
 *   ingest banner's existing behavior — proposals sit in ingestStore
 *   until the user opens the wiki page).
 */

import { useDocsStore } from '@/state/docsStore'
import { useEditorViewStore } from '@/state/editorViewStore'
import { createMarkStore, type MarkStoreHandle } from './markStoreImpl'

function resolveHandle(slug: string): MarkStoreHandle | null {
  const docs = useDocsStore.getState()
  const handle = docs.handles[slug]
  if (!handle) return null

  // EditorView only exists for the currently-active doc — and only
  // after MilkdownEditor's onViewReady has run. Read-side callers
  // (subscribe / list / get) work with `view: null`; PM-mutating
  // callers receive `view_not_ready` and can retry or queue.
  const view =
    docs.activeSlug === slug ? useEditorViewStore.getState().view : null

  return { view, ydoc: handle.ydoc }
}

export const markStore = createMarkStore({ getHandle: resolveHandle })
