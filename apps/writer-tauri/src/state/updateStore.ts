// Runtime mirror of the Rust update state machine. Non-persisted — update
// status is ephemeral process state, not a user preference. Written only by
// the `updater:state` event subscription (src/hooks/useUpdaterEvents.ts);
// read by the About settings row to render "the user driver" (the UI just
// reflects whatever state Rust broadcasts).

import { create } from 'zustand'
import type { UpdateState } from '@/lib/updater'

interface UpdateStoreState {
  state: UpdateState
  set: (state: UpdateState) => void
}

export const useUpdateStore = create<UpdateStoreState>((set) => ({
  state: { status: 'idle' },
  set: (state) => set({ state }),
}))
