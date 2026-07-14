// Production navigation helpers for the CodeMirror editor — the real wiring behind
// the prototype's toast stand-ins. Resolution + URL-hash navigation match
// wikilinkClickPlugin (the ProseMirror path) exactly, so both editors behave the same.

import { useDocsStore } from '@/state/docsStore'
import { buildViewUrl } from '@/lib/viewUrl'

/** Resolve a wikilink title to a LIVE doc slug (case-insensitive; archived + system
 * pages excluded) and navigate via the URL hash — the single source of truth for the
 * active doc. A broken/unresolved title is a no-op (create-on-click is a later chunk,
 * via the wikilink palette). */
export function navigateToNoteByTitle(title: string): void {
  const key = title.trim().toLowerCase()
  if (!key) return
  const store = useDocsStore.getState()
  const target = store.knownDocs.find(
    (d) => !d.type.startsWith('system:') && (d.title ?? '').trim().toLowerCase() === key,
  )
  if (!target) return
  window.location.hash = buildViewUrl({
    tab: store.sidebarTab,
    dayAnchor: store.dayAnchor,
    monthAnchor: store.monthAnchor,
    slug: target.slug,
  })
}

/** Navigate to a note by its slug (the card already holds one — no title resolution
 * needed). No-ops when the slug isn't a LIVE catalog doc (e.g. an inspect-only
 * proposal whose page was never materialised, or a stale pending change for a deleted
 * note) — navigating to a dead slug would just blank the editor. Returns whether it
 * navigated. Sets the URL hash, the single source of truth for the active doc. */
export function navigateToNoteBySlug(slug: string): boolean {
  const store = useDocsStore.getState()
  const target = store.knownDocs.find((d) => d.slug === slug)
  if (!target) return false
  window.location.hash = buildViewUrl({
    tab: store.sidebarTab,
    dayAnchor: store.dayAnchor,
    monthAnchor: store.monthAnchor,
    slug,
  })
  return true
}

/** Does this wikilink title resolve to a LIVE note? Drives blue (known) vs red
 * (broken) styling. Same filter as navigateToNoteByTitle, read fresh each call so
 * newly created/renamed notes are reflected on the next decoration rebuild. */
export function isKnownNoteTitle(title: string): boolean {
  const key = title.trim().toLowerCase()
  if (!key) return false
  return useDocsStore
    .getState()
    .knownDocs.some(
      (d) => !d.type.startsWith('system:') && (d.title ?? '').trim().toLowerCase() === key,
    )
}
