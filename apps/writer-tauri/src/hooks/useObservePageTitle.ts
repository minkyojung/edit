// Observes the in-body page title element and publishes its
// visibility to pageHeaderStore. EditorTabs reads that signal to fade
// its own title label in/out — the Apple Notes "sticky title on
// scroll" pattern.
//
// rootMargin top is shrunk by the editor header height so a title
// that has scrolled *under* the header (still technically in the
// window viewport) is treated as out-of-view. Without this, the
// header label would only appear once the title fully cleared the
// header, leaving a window where both titles read at once.

import { useEffect, type RefObject } from 'react'
import { usePageHeaderStore } from '@/state/pageHeaderStore'

export function useObservePageTitle(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const node = ref.current
    if (!node) return

    const setTitleInView = usePageHeaderStore.getState().setTitleInView
    const headerH = parseHeaderHeight() ?? 44

    const observer = new IntersectionObserver(
      ([entry]) => {
        setTitleInView(entry.isIntersecting)
      },
      {
        root: null,
        rootMargin: `-${headerH}px 0px 0px 0px`,
        threshold: 0,
      },
    )
    observer.observe(node)

    return () => {
      observer.disconnect()
      // Unmounting on doc switch resets the assumption to "title
      // visible" because new docs open scrolled to top. Without this
      // reset, the header label would briefly flash visible until
      // the next observer callback ran on the new title node.
      usePageHeaderStore.getState().setTitleInView(true)
    }
  }, [ref])
}

function parseHeaderHeight(): number | null {
  if (typeof window === 'undefined') return null
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--header-h')
    .trim()
  if (!raw) return null
  if (raw.endsWith('rem')) {
    const n = parseFloat(raw)
    const rootSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    return Number.isFinite(n) ? n * rootSize : null
  }
  if (raw.endsWith('px')) {
    const n = parseFloat(raw)
    return Number.isFinite(n) ? n : null
  }
  return null
}
