// Transient signal: is the in-body page title currently visible to
// the reader? Drives the Apple Notes / Pages "sticky title on scroll"
// pattern — when the body title scrolls out of view, EditorHeader
// reveals the active doc label so the user never loses context.
//
// PageHeader publishes; EditorTabs subscribes. The store stays
// out of layoutStore (which is persisted) because this state is
// per-frame UI signal, not user preference.

import { create } from 'zustand'

interface PageHeaderState {
  /** True while the body page title intersects the viewport. Default
   * true — on first mount, before observer fires, we assume the title
   * is visible so the header label stays hidden (the more common
   * "doc just opened" state). */
  titleInView: boolean
  setTitleInView: (v: boolean) => void
}

export const usePageHeaderStore = create<PageHeaderState>((set) => ({
  titleInView: true,
  setTitleInView: (v) => set({ titleInView: v }),
}))
