// Tracks which thread the user is currently viewing for a given document.
// Stored in localStorage rather than the Y.Doc — viewing one thread on
// laptop while reading another on phone shouldn't sync.
//
// If the stored id no longer exists or its thread is archived, fall back
// to the first active thread.

import { useCallback, useEffect, useState } from 'react'
import type { ThreadMeta } from '@/chat/types'

function storageKey(slug: string) {
  return `writer-tauri:active-thread:${slug}`
}

function read(slug: string): string | null {
  try {
    return localStorage.getItem(storageKey(slug))
  } catch {
    return null
  }
}

function write(slug: string, id: string | null) {
  try {
    if (id == null) localStorage.removeItem(storageKey(slug))
    else localStorage.setItem(storageKey(slug), id)
  } catch {
    // localStorage may be unavailable (private browsing, quota); ignore.
  }
}

export interface UseActiveThreadResult {
  activeId: string | null
  setActiveId: (id: string | null) => void
}

export function useActiveThread(
  slug: string | null,
  active: ThreadMeta[],
): UseActiveThreadResult {
  const [activeId, setActiveIdState] = useState<string | null>(null)

  // Reload from localStorage whenever the document changes.
  useEffect(() => {
    if (!slug) {
      setActiveIdState(null)
      return
    }
    setActiveIdState(read(slug))
  }, [slug])

  // Reconcile with current active list — if the stored thread is gone or
  // archived, fall back to the first active. This also handles the
  // "first thread auto-created" case (caller adds it to active, we adopt).
  useEffect(() => {
    if (!slug) return
    const exists = activeId != null && active.some((t) => t.id === activeId)
    if (exists) return
    const fallback = active[0]?.id ?? null
    if (fallback !== activeId) {
      setActiveIdState(fallback)
      write(slug, fallback)
    }
  }, [slug, active, activeId])

  const setActiveId = useCallback<UseActiveThreadResult['setActiveId']>(
    (id) => {
      if (!slug) return
      setActiveIdState(id)
      write(slug, id)
    },
    [slug],
  )

  return { activeId, setActiveId }
}
