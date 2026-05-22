/**
 * viewUrl — builders for the day/week/month route shapes.
 *
 * Step 3 of the URL-as-source-of-truth migration replaces direct
 * docsStore setter calls with navigate() to one of these URLs.
 * Centralising the format here keeps the route shape known in one
 * file so a future change to e.g. swap the slug into a query
 * parameter is a single edit.
 *
 * Slugs may contain ':' (e.g. wiki:custom-foo) and other URL-unsafe
 * characters; encodeURIComponent matches the decodeURIComponent in
 * useRouteSync so a round trip is exact.
 */

export type SidebarTab = 'day' | 'week' | 'month'

interface BuildOptions {
  tab: SidebarTab
  dayAnchor: string
  monthAnchor: string
  slug?: string | null
}

export function buildViewUrl({ tab, dayAnchor, monthAnchor, slug }: BuildOptions): string {
  const slugSuffix = slug ? `/${encodeURIComponent(slug)}` : ''
  if (tab === 'day') return `/day/${dayAnchor}${slugSuffix}`
  if (tab === 'week') return `/week${slugSuffix}`
  return `/month/${monthAnchor}${slugSuffix}`
}

export function buildDayUrl(date: string, slug?: string | null): string {
  return buildViewUrl({ tab: 'day', dayAnchor: date, monthAnchor: '', slug })
}

export function buildMonthUrl(ym: string, slug?: string | null): string {
  return buildViewUrl({ tab: 'month', dayAnchor: '', monthAnchor: ym, slug })
}

export function buildWeekUrl(slug?: string | null): string {
  return buildViewUrl({ tab: 'week', dayAnchor: '', monthAnchor: '', slug })
}

/**
 * Inverse of the builders above — pulls the slug segment out of a
 * route pathname, or returns null when the URL doesn't carry a slug
 * (root, legacy /notes, or a bare day/week/month view).
 *
 * Centralising the parse here means the route shape lives in one
 * file: builders + parser agree by construction, and adding a new
 * view route is a single edit. Both `useRouteSync` and
 * `useActiveSlug` import this so they can't drift apart.
 *
 * The slug position varies per route family:
 *   /day/:date/:slug?      → parts[2]
 *   /week/:slug?           → parts[1]
 *   /month/:ym/:slug?      → parts[2]
 *   anything else          → null
 */
export function parseSlugFromPath(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (parts.length === 0) return null
  const [head, a, b] = parts
  if (head === 'day') return b ?? null
  if (head === 'week') return a ?? null
  if (head === 'month') return b ?? null
  return null
}

/**
 * Non-React read of the active slug. HashRouter encodes the live
 * route as the URL fragment, so callers outside React (PM plugins,
 * agent helpers, docFileSync, MarkHoverActionsLayer event handlers)
 * can read this whenever they need the current slug — no store
 * subscription required.
 *
 * Returns null in the same cases parseSlugFromPath returns null
 * (root, /notes, bare day/week/month view). Safe during SSR / tests
 * where window is undefined.
 */
export function getActiveSlugFromHash(): string | null {
  if (typeof window === 'undefined') return null
  const hash = window.location.hash
  const pathname = hash.startsWith('#') ? hash.slice(1) : hash
  return parseSlugFromPath(pathname)
}
