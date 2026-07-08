// Tracks which thread the user is currently viewing. Phase H: global
// — one active thread across the whole app, independent of which
// doc the user is looking at. The Cursor model: navigating between
// files does not change the chat thread you're in.
//
// Stored in localStorage under a single key. Per-doc keys from the
// pre-H layout (`writer-tauri:active-thread:<slug>`) become orphans
// after upgrade; they're left untouched (localStorage doesn't grow
// fast enough for cleanup to matter, and a future migration can
// sweep them if it ever does).
//
// Falls back to the first active thread when the stored id no
// longer exists or its thread is archived.

import { useCallback, useEffect, useState } from 'react'
import type { ThreadMeta } from '@/chat/types'
import { projectStorageKey } from '@/lib/windowRoot'

// Namespaced per window: each project window tracks its own active thread,
// so opening project B doesn't inherit project A's selection.
const STORAGE_KEY = projectStorageKey('writer-tauri:active-thread')

function read(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function write(id: string | null) {
  try {
    if (id == null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // localStorage may be unavailable (private browsing, quota); ignore.
  }
}

export interface UseActiveThreadResult {
  activeId: string | null
  setActiveId: (id: string | null) => void
}

export function useActiveThread(active: ThreadMeta[]): UseActiveThreadResult {
  // Initialise from localStorage on first mount. Per-doc remounts no
  // longer happen — ChatPanel stays mounted across page navigation
  // — so the useEffect-on-slug-change reload from the pre-H version
  // is gone.
  const [activeId, setActiveIdState] = useState<string | null>(() => read())

  // Reconcile with current active list — if the stored thread is gone
  // or archived, fall back to the first active. Also handles the
  // "first thread auto-created" case (caller adds it to active, we
  // adopt). The first-active fallback uses the picker's order, which
  // is most-recently-updated first.
  useEffect(() => {
    const exists = activeId != null && active.some((t) => t.id === activeId)
    if (exists) return
    const fallback = active[0]?.id ?? null
    if (fallback !== activeId) {
      setActiveIdState(fallback)
      write(fallback)
    }
  }, [active, activeId])

  const setActiveId = useCallback<UseActiveThreadResult['setActiveId']>((id) => {
    setActiveIdState(id)
    write(id)
  }, [])

  return { activeId, setActiveId }
}
