// Minimal change-notification store for events.db. The GitHub-activity
// card NodeViews subscribe to `version`; a sync bumps it so open cards
// re-query and re-render. No data is cached here — SQLite reads are
// cheap, and keeping the store data-free avoids a second source of truth
// (events.db stays canonical).

import { create } from 'zustand'

interface EventsStore {
  /** Incremented whenever events.db may have changed (e.g. after a sync). */
  version: number
  bump: () => void
}

export const useEventsStore = create<EventsStore>((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}))
