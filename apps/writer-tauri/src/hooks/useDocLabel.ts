// Single source of truth for the displayed label of a doc, used by
// every surface that renders a doc reference (tabs, sidebar, palette,
// breadcrumb, wikilink palette, unlinked-notes list, dialog title).
//
// Policy (Obsidian model — title is independent of body):
//
//   1. Daily entry  → meta.date (anchor; no editable title).
//   2. System page  → fixed name derived from the `system:*` type id.
//   3. Wiki / Writing → `knownDocs[slug].title`. This IS the filename
//      on disk (Path C Step 4); the only way to change it is the
//      explicit renameDoc action, never via body edits.
//   4. Fallback     → 'Untitled' when title is absent.
//
// Pre-Step-4 the writing branch fell back to the body's first line
// when title was empty. That branch is gone — the body and the title
// are decoupled, period. A doc with no title displays as 'Untitled'
// regardless of what the body contains. To name it, use the inline
// title input (PageHeader) or the Command Palette's Rename.

import { useDocsStore, isWikiDoc, type KnownDoc } from '@/state/docsStore'

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

/** Pure form of {@link useDocLabel} — the displayed label for a doc,
 * following the same policy. Exported for non-hook callers (e.g. the
 * command palette, which maps over many docs at once). */
export function docLabel(known: KnownDoc | undefined): string {
  if (!known) return 'Untitled'

  if (known.type === 'daily' && known.date) return formatDailyLabel(known.date)

  if (isWikiDoc(known)) {
    const cached = known.title?.trim()
    if (cached) return cached
    // System pages have a meaningful suffix to fall back on
    // ('conventions' / 'log' / 'index'). Custom wiki pages with no
    // title yet display as 'Untitled' until the user renames.
    if (known.type.startsWith('system:')) return known.type.replace(/^system:/, '')
    return 'Untitled'
  }

  // Writing notes — body decoupled from title (Step 4). Title is
  // whatever renameDoc has set, or 'Untitled'.
  return known.title?.trim() || 'Untitled'
}

export function useDocLabel(slug: string | null): string {
  const known = useDocsStore((s) =>
    slug ? s.knownDocs.find((d) => d.slug === slug) : undefined,
  )
  return docLabel(known)
}
