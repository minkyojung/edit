// Session-memory recency for docs — powers the ⌘K palette's empty-query
// "Recent" ordering (most-recently-opened first). Every doc-open funnels
// through `openDoc`, which records the slug here.
//
// Deliberately NOT persisted: slugs are re-minted every boot (identity
// across restarts is the file path, not the slug), and `knownDocs` is
// rebuilt from disk each launch. Cross-restart recency would need to key
// by vault path + a real frecency score — a follow-up. Within a session
// slugs are stable, so a plain move-to-front list is enough.

import { create } from 'zustand'

const CAP = 50

interface RecentDocsStore {
  /** Slugs most-recently-opened first. */
  order: string[]
  recordOpen: (slug: string) => void
}

export const useRecentDocsStore = create<RecentDocsStore>((set) => ({
  order: [],
  recordOpen: (slug) =>
    set((s) => ({
      order: [slug, ...s.order.filter((x) => x !== slug)].slice(0, CAP),
    })),
}))
