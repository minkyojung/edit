/**
 * usePersistLastPath — remember the last-viewed doc so the next cold boot
 * can reopen it.
 *
 * Persists the doc's vault-relative PATH (+ the view shape), NOT the raw
 * URL: the URL carries the slug, which is an ephemeral per-boot handle and
 * would be stale next launch. `bootstrap` resolves the path back to a fresh
 * slug after the vault scan and rebuilds the route (see lib/lastView + the
 * restore in bootstrapSlice). This is why restore moved out of main.tsx's
 * pre-mount IIFE — path→slug needs the scanned catalog, which only exists
 * post-scan.
 */

import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { parseSlugFromPath, type SidebarTab } from '@/lib/viewUrl'
import { pathForDoc } from '@/lib/docPaths'
import { useDocsStore } from '@/state/docsStore'
import { writeLastView } from '@/lib/lastView'

export function usePersistLastPath() {
  const { pathname } = useLocation()
  useEffect(() => {
    // Only day/week/month routes carry a doc slug; roots, /notes, and
    // /file/* return null and leave the last view untouched.
    const slug = parseSlugFromPath(pathname)
    if (!slug) return
    const { knownDocs } = useDocsStore.getState()
    const doc = knownDocs.find((d) => d.slug === slug)
    if (!doc) return
    const path = pathForDoc(doc, (s) => knownDocs.find((d) => d.slug === s))
    if (!path) return
    const parts = pathname.split('/').filter(Boolean)
    const tab = parts[0] as SidebarTab
    writeLastView({
      path,
      tab,
      dayAnchor: tab === 'day' ? (parts[1] ?? '') : '',
      monthAnchor: tab === 'month' ? (parts[1] ?? '') : '',
    })
  }, [pathname])
}
