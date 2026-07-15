/**
 * openDoc — the single "open a note" entry point.
 *
 * Every click-a-note site (sidebar tree, tabs, command palette, wikilinks,
 * chat tool results, …) used to hand-build `buildViewUrl({ tab, dayAnchor,
 * monthAnchor, slug })` from the store's view state and then `navigate(...)`
 * (React) or `window.location.hash = ...` (non-React). This centralises that
 * one shape: callers just say `openDoc(slug)`.
 *
 * Kept out of `lib/viewUrl.ts` (which stays a pure, store-free URL builder,
 * imported by the docsStore) to avoid a store↔viewUrl import cycle.
 */

import { useDocsStore } from '@/state/docsStore'
import { buildViewUrl } from '@/lib/viewUrl'
import { appNavigate } from '@/lib/appNavigate'

/** Build the URL that opens `slug` in the CURRENT sidebar view (day / week /
 * month + its anchor), read from the store at call time. Non-reactive, so it
 * works from React and non-React callers alike. */
export function buildCurrentViewUrl(slug: string): string {
  const { sidebarTab, dayAnchor, monthAnchor } = useDocsStore.getState()
  return buildViewUrl({ tab: sidebarTab, dayAnchor, monthAnchor, slug })
}

/** Open `slug` — navigate to it in the current view via the router bridge. */
export function openDoc(slug: string, opts?: { replace?: boolean }): void {
  appNavigate(buildCurrentViewUrl(slug), opts)
}
