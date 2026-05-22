/**
 * usePersistLastPath — write the current pathname to localStorage on
 * every change, so the next cold boot can restore it before React
 * mounts (see main.tsx).
 *
 * Why a separate concern from docsStore.persist: this is session-
 * restore state, not domain state. Keeping it out of the zustand
 * persist blob avoids a schema migration and lets the boot-time
 * restorer run *before* React mounts (zustand rehydrate fires during
 * module init, but the URL needs to be set on window.location.hash
 * before HashRouter reads it).
 *
 * Skips slug-less roots (`/`, `/notes`) — those are redirect targets
 * and persisting them would round-trip the user to "today's daily"
 * even when they had a real note open last session.
 */

import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

export const LAST_PATH_STORAGE_KEY = 'writer-tauri:lastPath'

export function usePersistLastPath() {
  const { pathname } = useLocation()
  useEffect(() => {
    if (pathname === '/' || pathname === '/notes') return
    try {
      localStorage.setItem(LAST_PATH_STORAGE_KEY, pathname)
    } catch {
      // localStorage write can throw under private browsing / quota —
      // session restore is a nice-to-have, not a correctness requirement,
      // so we swallow.
    }
  }, [pathname])
}
