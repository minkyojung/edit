/**
 * Reactive view of the domain Marks for a doc.
 *
 * Thin React wrapper over `markStore.subscribe`. Re-renders whenever a
 * mark is added / accepted / rejected / drift-flips in the active doc.
 * The legacy `useMarks` returns raw `StoredMark` entries from
 * `Y.Map('marks')`; that shape predates the Mark domain model and
 * isn't drift-aware, so new code should use this hook instead.
 */

import { useEffect, useState } from 'react'
import { markStore } from '@/domain/markStoreInstance'
import type { Mark } from '@/domain/marks'

/** All marks for the given slug. Empty list when slug is null or
 * the doc isn't currently active in the markStore. */
export function useDocMarks(slug: string | null): Mark[] {
  const [marks, setMarks] = useState<Mark[]>([])

  useEffect(() => {
    if (!slug) {
      setMarks([])
      return
    }
    // subscribe fires immediately with the current state, so we don't
    // need a separate initial-read pass.
    return markStore.subscribe(slug, setMarks)
  }, [slug])

  return marks
}

/** Convenience: a single mark by id, reactive. Returns null when the
 * mark id isn't in the doc's mark map (e.g. accepted/rejected and
 * already swept). */
export function useDocMark(slug: string | null, markId: string | null): Mark | null {
  const marks = useDocMarks(slug)
  if (!markId) return null
  return marks.find((m) => m.id === markId) ?? null
}
