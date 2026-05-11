// Single source of truth for the displayed label of a doc, used by
// every surface that renders a doc reference (tabs, sidebar tree,
// breadcrumb, wikilink palette, unlinked-notes list, dialog title).
//
// Resolution order:
//   1. Daily entry  → meta.date (anchor; no editable title at all).
//   2. Wiki entry   → live Y.Text('title') if non-empty, else the
//      cached knownDocs.title (set at create time for both seeds and
//      custom pages), else a type-derived label. Wiki docs are
//      bootstrapped without a ydoc title, so without this branch
//      they'd all read as 'Untitled'. The cached-title fallback is
//      what lets a custom 'wiki:custom-<id>' page show its real
//      user-given name ('people') instead of the opaque suffix.
//   3. Warm writing → Y.Text('title') from the live ydoc. Reflects
//      every keystroke, including across collab peers.
//   4. Cold writing → knownDocs.title, the persisted mirror set at
//      create time and kept in sync by the per-handle title observer
//      installed in docsStore.ensureHandle. Lets closed/unopened
//      docs still show their real label without N WebSockets.
//   5. Fallback     → 'Untitled'.

import { useDocsStore } from '@/state/docsStore'
import { useDocTitle } from './useDocTitle'

const DAILY_LABEL_FMT = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
})

function formatDailyLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return date
  const [, y, mo, d] = m
  const dt = new Date(Number(y), Number(mo) - 1, Number(d))
  if (Number.isNaN(dt.getTime())) return date
  return DAILY_LABEL_FMT.format(dt)
}

export function useDocLabel(slug: string | null): string {
  const handle = useDocsStore((s) => (slug ? s.handles[slug] : undefined))
  const known = useDocsStore((s) =>
    slug ? s.knownDocs.find((d) => d.slug === slug) : undefined,
  )
  const title = useDocTitle(handle?.ydoc ?? null)

  if (known?.type === 'daily' && known.date) return formatDailyLabel(known.date)
  if (known?.type?.startsWith('wiki:')) {
    const live = title.trim()
    if (live) return live
    const cached = known.title?.trim()
    if (cached) return cached
    // Fall back to the type-derived label rather than 'Untitled' so
    // the sidebar reads as a meaningful wiki section even before
    // the user touches the title field. For custom pages the
    // cached title above wins, so this branch only fires for
    // seed types (belief / entity / episode).
    return known.type.replace(/^wiki:/, '')
  }
  if (handle) return title || 'Untitled'
  return known?.title || 'Untitled'
}
