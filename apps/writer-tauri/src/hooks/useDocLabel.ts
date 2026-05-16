// Single source of truth for the displayed label of a doc, used by
// every surface that renders a doc reference (tabs, sidebar tree,
// breadcrumb, wikilink palette, unlinked-notes list, dialog title).
//
// Policy (Notion-style — explicit title wins, body-extraction is a
// last-resort fallback for writing docs only):
//
//   1. Daily entry  → meta.date (anchor; no editable title at all).
//   2. Wiki entry   → the cached knownDocs.title set at
//      createCustomWikiPage time (e.g. "Michael"). This is the
//      canonical name. We do NOT scan the body anymore — body
//      mutations (adding bullets, accepting AI proposals, etc.)
//      must not rename the page. If no title was set at create
//      time, fall through to a type-derived label or 'Untitled'.
//   3. Writing      → first heading.textContent / first paragraph
//      .textContent of the body, plain text only (deriveLabel
//      strips inline marks via Y.Text.toDelta). Reflects every
//      keystroke. If the body is empty, falls through to the
//      cached knownDocs.title.
//   4. Fallback     → 'Untitled'.
//
// Why the wiki branch dropped body extraction: ingest writes
// proofAuthored marks + bullet lists into wiki pages. The previous
// "first body line" rule pulled the first bullet's text (or, before
// the deriveLabel fix, the raw `<proofAuthored …>` tag) into the
// sidebar — so a page named "Michael" displayed as
// "Joined as new manager" or worse. Notion / Obsidian / Linear all
// keep title in an explicit field; this brings us in line.

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
    // Explicit title is canonical. Body content does not rename a
    // wiki page — see file-level doc.
    const cached = known.title?.trim()
    if (cached) return cached
    // No title was set at create time (rare — pre-rename legacy
    // pages, or programmatic creators that bypassed the title
    // field). System pages carry a meaningful suffix in their type;
    // custom pages don't, so they read as 'Untitled' until renamed.
    if (known.type.startsWith('system:')) return known.type.replace(/^system:/, '')
    if (known.type.startsWith('wiki:custom-')) return 'Untitled'
    return known.type.replace(/^wiki:/, '')
  }
  if (handle) return title || known?.title || 'Untitled'
  return known?.title || 'Untitled'
}
