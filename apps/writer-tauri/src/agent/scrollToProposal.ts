// Jump from a chat step to the matching mark in the editor.
//
// Three cases:
//   1) The mark's doc is already active AND its view has the mark →
//      scroll immediately.
//   2) The doc is open but the editor is unmounted (different tab) →
//      flip activeSlug; MilkdownEditor will drain pendingScroll on
//      its next mount and complete the jump.
//   3) The doc is closed/archived OR the mark never landed (proposal
//      was rejected before apply) → no-op. We don't try to reopen
//      closed docs — that's a different feature.
//
// Returns true when a scroll happened or was queued, false otherwise.
// Callers (chat step click handler) ignore the return today, but the
// boolean is there for future "couldn't find the mark" UI.

import { useDocsStore } from '@/state/docsStore'
import { useEditorViewStore } from '@/state/editorViewStore'
import { usePendingScroll } from '@/state/pendingScrollStore'
import { scrollToMark } from '@/editor/scrollToMark'
import { buildViewUrl, getActiveSlugFromHash } from '@/lib/viewUrl'

export function scrollToProposal(slug: string, markId: string): boolean {
  const docsState = useDocsStore.getState()
  if (!docsState.handles[slug]) return false

  if (getActiveSlugFromHash() === slug) {
    const view = useEditorViewStore.getState().view
    if (view && scrollToMark(view, markId)) return true
    // View not ready (mid-mount) — queue and let drain handle it.
    usePendingScroll.getState().set(slug, markId)
    return true
  }

  usePendingScroll.getState().set(slug, markId)
  // Drive the doc switch through location.hash so the jump lands in
  // the back/forward stack just like a user-initiated navigation;
  // useRouteSync calls setActive on the next tick.
  window.location.hash = buildViewUrl({
    tab: docsState.sidebarTab,
    dayAnchor: docsState.dayAnchor,
    monthAnchor: docsState.monthAnchor,
    slug,
  })
  return true
}
