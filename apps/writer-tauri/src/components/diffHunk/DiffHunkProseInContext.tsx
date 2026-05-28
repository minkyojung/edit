// Prose-style diff hunk WITH SURROUNDING CONTEXT.
//
// Renders the change in its place on the page: N markdown blocks
// above the change (plain), the changed block (red tint for what's
// removed), the synthesized new block (green tint for what's added),
// then N blocks below. The visual mirrors what the user sees when
// reading the actual page in the editor, just cropped to the
// neighbourhood of the change.
//
// Falls back to the flat `DiffHunkProse` view (no context blocks)
// when the helper can't resolve the anchor — happens when the
// editor parser isn't mounted, the page body is empty, or the
// before-text doesn't match anything in the current page.

import { useDocsStore } from '@/state/docsStore'
import { useEditorViewStore } from '@/state/editorViewStore'
import type { PendingEdit } from '@/state/pendingChangesStore'
import { buildDiffHunkProseInContextBody } from '@/lib/diffHunk/proseContext'
import { DiffHunkProse } from './DiffHunkProse'

export function DiffHunkProseInContext({
  pageSlug,
  edit,
  contextBlocks = 2,
  pageMarkdownOverride,
}: {
  pageSlug: string
  edit: PendingEdit
  contextBlocks?: number
  /** Snapshot of the page's markdown to render against instead of
   * the live `bodyMarkdown`. The Review Panel passes the
   * pendingChangesStore's `pageMarkdownSnapshot` so a card stays a
   * faithful "before" view of the change even after the user
   * accepts and the live page moves on. */
  pageMarkdownOverride?: string
}) {
  // Live page markdown is the fallback. We always subscribe so the
  // component re-renders when the page is hydrated / edited (when
  // no override is in play, which is the legacy path for entries
  // created before the snapshot field existed).
  const liveMarkdown = useDocsStore(
    (s) => s.handles[pageSlug]?.bodyMarkdown ?? '',
  )
  const pageMarkdown =
    pageMarkdownOverride !== undefined ? pageMarkdownOverride : liveMarkdown

  // Subscribe to parser availability so the component re-renders
  // when the editor mounts. The helper itself reads parser via
  // `getState` (non-React surface); this hook is the React-side
  // reactivity wire.
  const parserReady = useEditorViewStore((s) => s.parser !== null)

  // Build the DOM during render. The component re-renders only when
  // one of its tracked inputs changes, so this isn't called on
  // unrelated parent updates. The ref callback then mounts the
  // latest DOM imperatively.
  const dom = parserReady
    ? buildDiffHunkProseInContextBody({
        pageMarkdown,
        edit,
        contextBlocks,
      })
    : null

  if (!dom) {
    return <DiffHunkProse before={edit.before} after={edit.after} />
  }

  return (
    <div
      className="flex flex-col"
      ref={(el) => {
        if (!el) return
        el.innerHTML = ''
        // The fragment's children move out on append; re-mounts
        // (StrictMode double-invoke, React fast-refresh) would
        // otherwise get an empty fragment. Clone so the source
        // fragment stays intact for re-mounts.
        el.appendChild(dom.cloneNode(true))
      }}
    />
  )
}
