// Document metadata stored alongside the body in the same Y.Doc.
// Currently captures `type` (daily / writing — wiki types come later)
// and, for daily entries, the ISO date the entry anchors to.
//
// Lives in ydoc.getMap('meta') so it syncs over Hocuspocus next to
// the body and title; the docsStore mirrors a slim copy in
// localStorage for sidebar listings without forcing every doc to
// open its provider.

import { useEffect, useState } from 'react'
import * as Y from 'yjs'

export type DocType = 'daily' | 'writing'

export interface DocMeta {
  type: DocType
  /** YYYY-MM-DD when type === 'daily'. Undefined otherwise. */
  date?: string
  /** Parent doc's slug for tree-nested writing notes. Undefined =
   * root (a daily, or an independent writing doc that isn't filed
   * under any parent yet). */
  parentId?: string
  createdAt?: string
}

const META_KEY = 'meta'

function readMeta(ydoc: Y.Doc): DocMeta {
  const map = ydoc.getMap(META_KEY)
  const type = (map.get('type') as DocType | undefined) ?? 'writing'
  const date = map.get('date') as string | undefined
  const parentId = map.get('parentId') as string | undefined
  const createdAt = map.get('createdAt') as string | undefined
  return { type, date, parentId, createdAt }
}

export function useDocMeta(ydoc: Y.Doc | null): {
  meta: DocMeta
  setMeta: (next: Partial<DocMeta>) => void
} {
  const [meta, setLocalMeta] = useState<DocMeta>({ type: 'writing' })

  useEffect(() => {
    if (!ydoc) {
      setLocalMeta({ type: 'writing' })
      return
    }
    setLocalMeta(readMeta(ydoc))
    const map = ydoc.getMap(META_KEY)
    const onChange = () => setLocalMeta(readMeta(ydoc))
    map.observe(onChange)
    return () => map.unobserve(onChange)
  }, [ydoc])

  const setMeta = (next: Partial<DocMeta>) => {
    if (!ydoc) return
    const map = ydoc.getMap(META_KEY)
    ydoc.transact(() => {
      if (next.type !== undefined) map.set('type', next.type)
      if (next.date !== undefined) map.set('date', next.date)
      if (next.parentId !== undefined) map.set('parentId', next.parentId)
      if (next.createdAt !== undefined) map.set('createdAt', next.createdAt)
    })
  }

  return { meta, setMeta }
}

/** One-shot read used during bootstrap, before React state is wired
 * up. Returns the same shape as useDocMeta's `meta`. */
export function readDocMeta(ydoc: Y.Doc): DocMeta {
  return readMeta(ydoc)
}

/** One-shot write — used by migration / first-create paths in the
 * store where we only need to seed values once. */
export function writeDocMeta(ydoc: Y.Doc, next: Partial<DocMeta>): void {
  const map = ydoc.getMap(META_KEY)
  ydoc.transact(() => {
    if (next.type !== undefined) map.set('type', next.type)
    if (next.date !== undefined) map.set('date', next.date)
    if (next.createdAt !== undefined) map.set('createdAt', next.createdAt)
  })
}

/** Format a Date as YYYY-MM-DD in local time. We pin to local because
 * "today's journal" follows the user's wall clock, not UTC. */
export function formatLocalDate(d: Date): string {
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export function todayLocalDate(): string {
  return formatLocalDate(new Date())
}
