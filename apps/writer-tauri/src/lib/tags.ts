// Tag aggregation — the vault's tag list is a *derived* view of the catalog
// (knownDocs), never a stored index that could drift from the notes. Callers
// memoize the result; this stays a pure function of its input.

import type { KnownDoc } from '@/state/docsStore'

export interface TagCount {
  tag: string
  count: number
}

/** Canonical tag-list shape: each tag trimmed, blanks dropped, duplicates
 *  removed (first occurrence wins). The single normalization used by both
 *  the read path (frontmatterToMeta) and the write path (setDocTags) so a
 *  note tagged in-app and one read from disk end up identical. */
export function normalizeTags(tags: readonly string[]): string[] {
  return Array.from(
    new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0)),
  )
}

/** Every distinct tag across the given docs with how many notes carry it,
 *  sorted by count (desc) then name (asc) so the busiest tags surface first
 *  and ties are stable. */
export function aggregateTags(docs: readonly KnownDoc[]): TagCount[] {
  const counts = new Map<string, number>()
  for (const doc of docs) {
    for (const tag of doc.tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}
