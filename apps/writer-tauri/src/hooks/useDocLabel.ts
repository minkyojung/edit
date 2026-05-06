// Single source of truth for the displayed label of a doc, used by
// every surface that renders a doc reference (tabs, sidebar tree,
// breadcrumb, wikilink palette, unlinked-notes list, dialog title).
//
// Resolution order:
//   1. Daily entry  → meta.date (anchor; no editable title at all).
//   2. Wiki entry   → live Y.Text('title') if non-empty, else the
//      type-derived name ('belief' / 'entity' / 'episode'). Wiki
//      docs are bootstrapped without a ydoc title, so without this
//      branch they'd all read as 'Untitled'.
//   3. Warm writing → Y.Text('title') from the live ydoc. Reflects
//      every keystroke, including across collab peers.
//   4. Cold writing → knownDocs.title, the persisted mirror set at
//      create time and kept in sync by the per-handle title observer
//      installed in docsStore.ensureHandle. Lets closed/unopened
//      docs still show their real label without N WebSockets.
//   5. Fallback     → 'Untitled'.

import { useDocsStore } from '@/state/docsStore'
import { useDocTitle } from './useDocTitle'

export function useDocLabel(slug: string | null): string {
  const handle = useDocsStore((s) => (slug ? s.handles[slug] : undefined))
  const known = useDocsStore((s) =>
    slug ? s.knownDocs.find((d) => d.slug === slug) : undefined,
  )
  const { title } = useDocTitle(handle?.ydoc ?? null)

  if (known?.type === 'daily' && known.date) return known.date
  if (known?.type?.startsWith('wiki:')) {
    const live = title.trim()
    if (live) return live
    // Fall back to the type-derived label rather than 'Untitled'
    // so the sidebar reads as a meaningful wiki section even
    // before the user touches the title field.
    return known.type.replace(/^wiki:/, '')
  }
  if (handle) return title || 'Untitled'
  return known?.title || 'Untitled'
}
