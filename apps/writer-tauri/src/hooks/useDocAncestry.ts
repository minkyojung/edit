// Walks the parentId chain in the docs registry to surface a doc's
// ancestor path. Used by the editor breadcrumb so a deeply nested
// writing note can show "Today › 아이디어 › 후속 메모" above the
// title field. Stops at the root (a parentId-less node) or after a
// safety bound — broken parentId loops shouldn't lock the renderer.

import { useMemo } from 'react'
import { useDocsStore, type KnownDoc } from '@/state/docsStore'

const MAX_DEPTH = 16

export interface AncestorEntry {
  slug: string
  /** Cached metadata; the live title comes from the doc's ydoc when
   * the handle is open. The breadcrumb uses doc-specific render
   * (e.g. relative date label for dailies) instead of titles, so we
   * just return the metadata and let the caller format. */
  meta: KnownDoc
}

/** Returns the ancestor chain for `slug`, NOT including the slug
 * itself, ordered root-first. So a depth-2 child returns
 * [grandparent, parent]. Returns [] when slug is null, unknown, or a
 * root node. */
export function useDocAncestry(slug: string | null): AncestorEntry[] {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  return useMemo(() => {
    if (!slug) return []
    const bySlug = new Map<string, KnownDoc>()
    for (const d of knownDocs) bySlug.set(d.slug, d)
    const chain: AncestorEntry[] = []
    let cursor = bySlug.get(slug)
    let steps = 0
    while (cursor?.parentId && steps < MAX_DEPTH) {
      const parent = bySlug.get(cursor.parentId)
      if (!parent) break
      chain.unshift({ slug: parent.slug, meta: parent })
      cursor = parent
      steps += 1
    }
    return chain
  }, [knownDocs, slug])
}
