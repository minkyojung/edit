/**
 * useRouteSync — one-way bridge from URL → docsStore mirrors.
 *
 * The URL carries three pieces of view state — sidebar tab, anchor
 * (date or month), and open slug. The "which doc is the user looking
 * at" question is answered by the URL directly (via useActiveSlug);
 * this hook keeps the store's *mirrors* of the other two (sidebarTab,
 * dayAnchor / monthAnchor) in sync, plus calls `ensureOpen(slug)` so
 * the URL-named doc gets promoted into the tab strip and its handle
 * warmed.
 *
 * Why parse pathname by hand instead of useParams: this hook mounts
 * outside any <Route>, so useParams has nothing to read. Hash-router
 * pathnames are short and well-formed enough that a single split +
 * decodeURIComponent beats wiring matchPath() against every shape.
 *
 * Compare-before-set: `ensureOpen` calls `ensureHandle` and touches
 * IDB; firing it on every render (StrictMode double-effect, sibling
 * store changes) would thrash collab handles. The ref-guarded
 * pathname check keeps the effect a no-op when the pathname hasn't
 * moved.
 */

import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useDocsStore } from '@/state/docsStore'

export function useRouteSync() {
  const { pathname } = useLocation()
  const lastApplied = useRef<string | null>(null)

  useEffect(() => {
    if (lastApplied.current === pathname) return
    lastApplied.current = pathname

    const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (parts.length === 0) return

    const store = useDocsStore.getState()
    const [head, a, b] = parts

    if (head === 'day') {
      if (store.sidebarTab !== 'day') store.setSidebarTab('day')
      if (a && store.dayAnchor !== a) store.setDayAnchor(a)
      if (b) store.ensureOpen(b)
    } else if (head === 'week') {
      if (store.sidebarTab !== 'week') store.setSidebarTab('week')
      if (a) store.ensureOpen(a)
    } else if (head === 'month') {
      if (store.sidebarTab !== 'month') store.setSidebarTab('month')
      if (a && store.monthAnchor !== a) store.setMonthAnchor(a)
      if (b) store.ensureOpen(b)
    }
    // /notes is intentionally ignored — kept as a deep-link target
    // only; no live caller navigates there anymore.
  }, [pathname])
}
