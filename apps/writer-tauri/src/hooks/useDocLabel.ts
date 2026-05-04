// Single source of truth for the displayed label of a doc, used by
// every surface that renders a doc reference (tabs, sidebar tree,
// breadcrumb, wikilink palette, unlinked-notes list, dialog title).
//
// Resolution order:
//   1. Daily entry  → meta.date (anchor; no editable title at all).
//   2. Warm writing → Y.Text('title') from the live ydoc. Reflects
//      every keystroke, including across collab peers.
//   3. Cold writing → knownDocs.title, the persisted mirror set at
//      create time and kept in sync by the per-handle title observer
//      installed in docsStore.ensureHandle. Lets closed/unopened
//      docs still show their real label without N WebSockets.
//   4. Fallback     → 'Untitled'.

import { useDocsStore } from '@/state/docsStore'
import { useDocTitle } from './useDocTitle'

export function useDocLabel(slug: string | null): string {
  const handle = useDocsStore((s) => (slug ? s.handles[slug] : undefined))
  const known = useDocsStore((s) =>
    slug ? s.knownDocs.find((d) => d.slug === slug) : undefined,
  )
  const { title } = useDocTitle(handle?.ydoc ?? null)

  if (known?.type === 'daily' && known.date) return known.date
  if (handle) return title || 'Untitled'
  return known?.title || 'Untitled'
}
