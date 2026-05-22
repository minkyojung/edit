/**
 * useActiveSlug — derive the active doc slug from the URL.
 *
 * This is the read-side counterpart to the navigate() pattern: every
 * caller that needs to know "which doc is the user looking at?" should
 * call this hook instead of reading `docsStore.activeSlug`. The URL is
 * the single source of truth; the store mirror (for now) just trails
 * along via useRouteSync.
 *
 * Why this exists as a separate hook from useRouteSync: useRouteSync
 * is a write-side bridge (URL → store), runs once at the router root,
 * and has side effects (ensureOpen). useActiveSlug is a pure read,
 * subscribes to useLocation, and is safe to call from any component
 * inside HashRouter.
 *
 * Returns null when the URL doesn't name a slug — root (`/`), the
 * legacy `/notes` route, or a bare day/week/month view. Callers must
 * tolerate null (typically: render an empty / "no doc" state).
 */

import { useLocation } from 'react-router-dom'
import { parseSlugFromPath } from '@/lib/viewUrl'

export function useActiveSlug(): string | null {
  const { pathname } = useLocation()
  return parseSlugFromPath(pathname)
}
