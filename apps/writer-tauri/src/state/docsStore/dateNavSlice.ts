/**
 * docsStore — date navigation slice.
 *
 * Owns the sidebar's date-view state: which sub-tab is showing
 * (Day / Week / Month) and where each anchored view is currently
 * pointed. None of these touch other slices, so this slice is the
 * cleanest extraction in the docsStore refactor — no cross-slice
 * `get()` calls, no shared helpers.
 *
 * Persistence: NONE. Every session restarts on the Day view with
 * `dayAnchor = today` and `monthAnchor = current month`. The
 * intentional "you're here, now" launch experience.
 *
 * Date arithmetic lives in `./helpers` — this slice only wires the
 * pure helpers into store actions.
 */

import { todayLocalDate } from '@/hooks/useDocMeta'
import {
  monthAnchorOf,
  shiftDayAnchor,
  shiftMonthAnchor,
} from './helpers'
import type { SetDocsState } from './types'

export interface DateNavSlice {
  /** Which sidebar date view is showing. Runtime-only — every session
   * starts on 'day' so the app reads as "you're here, now" on launch. */
  sidebarTab: 'day' | 'week' | 'month'
  /** Month the Month view is currently showing (YYYY-MM). Runtime-only —
   * the natural anchor on each launch is the current month. */
  monthAnchor: string
  /** Date the Day view is currently showing (YYYY-MM-DD). Runtime-only —
   * resets to today on each launch so the app reads as "you're here, now"
   * regardless of where the user wandered last session. */
  dayAnchor: string

  /** Switch the sidebar date view. */
  setSidebarTab: (tab: 'day' | 'week' | 'month') => void
  /** Set the Month view's anchor month (YYYY-MM). */
  setMonthAnchor: (anchor: string) => void
  /** Step the Month view's anchor by `delta` months (-1 / +1). */
  shiftMonth: (delta: number) => void
  /** Set the Day view's anchor date (YYYY-MM-DD). */
  setDayAnchor: (anchor: string) => void
  /** Step the Day view's anchor by `delta` days (-1 / +1). */
  shiftDay: (delta: number) => void
}

export const createDateNavSlice = (set: SetDocsState): DateNavSlice => ({
  sidebarTab: 'day',
  monthAnchor: monthAnchorOf(todayLocalDate()),
  dayAnchor: todayLocalDate(),

  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  setMonthAnchor: (anchor) => set({ monthAnchor: anchor }),
  shiftMonth: (delta) =>
    set((s) => ({ monthAnchor: shiftMonthAnchor(s.monthAnchor, delta) })),
  setDayAnchor: (anchor) => set({ dayAnchor: anchor }),
  shiftDay: (delta) =>
    set((s) => ({ dayAnchor: shiftDayAnchor(s.dayAnchor, delta) })),
})
