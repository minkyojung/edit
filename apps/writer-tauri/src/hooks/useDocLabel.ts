// Single source of truth for the displayed label of a doc, used by
// every surface that renders a doc reference (tabs, sidebar, palette,
// breadcrumb, wikilink palette, unlinked-notes list, dialog title).
//
// Policy (Bear / iA Writer style — body's first line is the title):
//
//   1. Daily entry  → meta.date (anchor; no editable title).
//   2. Wiki entry   → cached knownDocs.title, maintained by the
//      title mirror (docsStore.installTitleMirror) from the body's
//      first non-empty block. The body's first line IS the title.
//      Wiki mirror is gated on the first block being a heading —
//      bullet-first bodies stay with the cached title until the
//      user adds a heading (prevents the "Michael → Joined as new
//      manager" regression where a bullet got promoted to title).
//   3. Writing      → first heading.textContent / first paragraph
//      .textContent of the body, plain text only (deriveLabel
//      strips inline marks via Y.Text.toDelta).
//   4. Fallback     → 'Untitled' / type-derived label for system pages.
//
// deriveLabel returns plain text (Y.Text.toDelta inserts only — no
// inline-mark wrappers). proofAuthored / proofComment marks added
// by ingest or by the user can't leak raw XML into labels.

import { useDocsStore, isWikiDoc } from '@/state/docsStore'
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
  if (known && isWikiDoc(known)) {
    // Cached title is the canonical source. The title mirror
    // (docsStore.installTitleMirror) keeps it in sync with the
    // body's first block.
    const cached = known.title?.trim()
    if (cached) return cached
    // No title typed yet. System pages carry meaningful suffixes;
    // custom pages read as 'Untitled' until the user enters a name.
    if (known.type.startsWith('system:')) return known.type.replace(/^system:/, '')
    if (known.type.startsWith('wiki:custom-')) return 'Untitled'
    return known.type.replace(/^wiki:/, '')
  }
  if (handle) return title || known?.title || 'Untitled'
  return known?.title || 'Untitled'
}
