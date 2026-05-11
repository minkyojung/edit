// Document metadata stored alongside the body in the same Y.Doc.
// Captures `type` (daily / writing / wiki:*) and, for daily
// entries, the ISO date the entry anchors to.
//
// Lives in ydoc.getMap('meta') so it syncs over Hocuspocus next to
// the body and title; the docsStore mirrors a slim copy in
// localStorage for sidebar listings without forcing every doc to
// open its provider.

import * as Y from 'yjs'

// `wiki:*` = LLM-synthesized memory pages (Karpathy split: Sources
// vs Wiki). Distinct from `writing` so archive/delete guards and
// sidebar grouping can branch on a single field. The wiki branch is
// open-ended (`wiki:${string}`) so users can spawn custom pages
// alongside the bootstrapped seeds (belief / entity / episode).
export type DocType = 'daily' | 'writing' | `wiki:${string}`

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

/** One-shot read used during bootstrap, before any reactive
 * subscription is needed. Returns the same shape every consumer
 * would have observed via a live subscription if one existed. */
export function readDocMeta(ydoc: Y.Doc): DocMeta {
  return readMeta(ydoc)
}

/** One-shot write — used by migration / first-create paths in the
 * store where we only need to seed values once. 'doc-init' origin
 * marks this as a system-driven write so the UndoManager skips it
 * (we don't want Cmd+Z to undo "this doc was created"). */
export function writeDocMeta(ydoc: Y.Doc, next: Partial<DocMeta>): void {
  const map = ydoc.getMap(META_KEY)
  ydoc.transact(() => {
    if (next.type !== undefined) map.set('type', next.type)
    if (next.date !== undefined) map.set('date', next.date)
    if (next.createdAt !== undefined) map.set('createdAt', next.createdAt)
  }, 'doc-init')
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
