// Highlight record store — the durable, source-of-truth layer for user
// highlights on saved articles. Records live on the article's KnownDoc
// (catalog) and persist to `.meta.json` via the normal flush: every
// mutation here marks the slug dirty, and the auto-flush writes the
// updated sidecar. The editor's PM `proofHighlight` mark is a separate
// *render* of these records (applied on create, re-anchored on mount).
//
// This module is intentionally view-free — it only touches the catalog.
// Applying / removing the PM mark lives in the editor code that owns the
// view (it has the selection + positions); the two are called together.

import { useDocsStore } from '@/state/docsStore'
import { markSlugDirty } from '@/lib/docFileSync'
import type { HighlightRecord } from '@/lib/highlightTypes'

export function getHighlights(slug: string): HighlightRecord[] {
  return useDocsStore.getState().knownDocs.find((d) => d.slug === slug)?.highlights ?? []
}

export function getHighlight(slug: string, id: string): HighlightRecord | undefined {
  return getHighlights(slug).find((h) => h.id === id)
}

function patchHighlights(
  slug: string,
  fn: (prev: HighlightRecord[]) => HighlightRecord[],
): void {
  useDocsStore.setState((s) => ({
    knownDocs: s.knownDocs.map((d) =>
      d.slug === slug ? { ...d, highlights: fn(d.highlights ?? []) } : d,
    ),
  }))
  markSlugDirty(slug)
}

export function addHighlightRecord(slug: string, record: HighlightRecord): void {
  patchHighlights(slug, (prev) => [...prev, record])
}

export function removeHighlightRecord(slug: string, id: string): void {
  patchHighlights(slug, (prev) => prev.filter((h) => h.id !== id))
}

/** Set (or clear, when `note` is empty) the note on an existing
 * highlight. Returns the updated record so the caller can mirror the
 * note into the daily note. */
export function setHighlightNote(
  slug: string,
  id: string,
  note: string,
): HighlightRecord | undefined {
  const trimmed = note.trim()
  patchHighlights(slug, (prev) =>
    prev.map((h) => (h.id === id ? { ...h, note: trimmed || undefined } : h)),
  )
  return getHighlight(slug, id)
}
