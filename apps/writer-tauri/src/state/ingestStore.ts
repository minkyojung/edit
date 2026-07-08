// Daily-ingest dedup watermarks — the only state pull-based ingest needs.
//
// `lastEditedAt` is bumped on any observed note edit (the per-handle
// XmlFragment observer calls `markEdited`); `lastIngestedAt` is stamped after a
// successful ingest pass (`markIngested`). The Sync trigger re-ingests a note
// only when it's been edited since the last pass.
//
// The structured ingest engine's review queue + block-hash dedup that used to
// live here were removed when ingest moved to the general intake agent
// (proposals now flow through the standard pending-changes approval UI).

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface IngestState {
  /** Per-note ms-since-epoch of the most recent observed edit to the body. */
  lastEditedAt: Record<string, number>
  /** Per-note ms-since-epoch of the most recent successful ingest pass. */
  lastIngestedAt: Record<string, number>
  /** Stamp `lastEditedAt[slug]` to now — called by the per-handle edit
   * observer so any edit makes the note re-eligible for the next sync. */
  markEdited: (slug: string) => void
  /** Stamp `lastIngestedAt[slug]` to now after a successful ingest pass. */
  markIngested: (slug: string) => void
}

export const useIngestStore = create<IngestState>()(
  persist(
    (set) => ({
      lastEditedAt: {},
      lastIngestedAt: {},
      markEdited: (slug) =>
        set((s) => ({ lastEditedAt: { ...s.lastEditedAt, [slug]: Date.now() } })),
      markIngested: (slug) =>
        set((s) => ({ lastIngestedAt: { ...s.lastIngestedAt, [slug]: Date.now() } })),
    }),
    {
      name: 'writer-tauri:ingest',
      // v5: dropped the structured review queue, pending logs, and block-hash
      // dedup (ingest moved to the general intake agent). Only the edit /
      // ingest watermarks remain; old persisted state is discarded on the
      // version bump (best-effort dedup — a re-sync re-derives it).
      version: 5,
      partialize: (s) => ({
        lastEditedAt: s.lastEditedAt,
        lastIngestedAt: s.lastIngestedAt,
      }),
    },
  ),
)
