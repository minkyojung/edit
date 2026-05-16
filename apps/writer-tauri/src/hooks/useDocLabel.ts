// Single source of truth for the displayed label of a doc, used by
// every surface that renders a doc reference (tabs, sidebar tree,
// breadcrumb, wikilink palette, unlinked-notes list, dialog title).
//
// Policy (Notion-style — title is an explicit field, body is body):
//
//   1. Daily entry  → meta.date (anchor; no editable title).
//   2. Wiki entry   → cached knownDocs.title. This is set either by
//      ingest (entity name like "Michael") or by the user typing
//      into WikiPageTitle (the input rendered above the editor body
//      in MilkdownEditor). The body is never used for the wiki
//      label — that was the regression source we just eliminated.
//      Empty cached title falls through to a type-derived label
//      or 'Untitled'.
//   3. Writing      → first heading.textContent / first paragraph
//      .textContent of the body, plain text only (deriveLabel
//      strips inline marks via Y.Text.toDelta). Writing docs don't
//      have a separate title input today; the body's first line is
//      the natural title slot.
//   4. Fallback     → 'Untitled'.
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
    // Cached title is the single source of truth. WikiPageTitle (the
    // input above the editor body) writes here via setDocTitle.
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
