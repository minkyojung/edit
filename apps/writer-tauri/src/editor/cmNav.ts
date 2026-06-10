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
    (d) => !d.archivedAt && !d.type.startsWith('system:') && (d.title ?? '').trim().toLowerCase() === key,
  )
  if (!target) return
  window.location.hash = buildViewUrl({
    tab: store.sidebarTab,
    dayAnchor: store.dayAnchor,
    monthAnchor: store.monthAnchor,
    slug: target.slug,
  })
}
