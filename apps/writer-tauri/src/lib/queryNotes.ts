// Metadata query over the note catalog — the host-side filter behind the AI
// `query_notes` tool. Pure and deterministic so it can be unit-tested without
// the sidecar bridge: given the catalog + a where-clause, it returns lightweight
// REFERENCES (path + title + status + tags), never bodies. The model Reads the
// paths it wants. grep is unreliable on the multi-line `tags:` frontmatter
// block, which is exactly why this structured filter exists.

import type { KnownDoc } from '@/state/docsStore'
import { pathForDoc, type DocLookup, type DocStatus } from '@/lib/docPaths'
import { normalizeTags } from '@/lib/tags'

export interface NoteRef {
  path: string
  title: string
  status: DocStatus | null
  tags: string[]
}

export interface NoteQuery {
  status?: DocStatus
  /** Match a note carrying ANY of these tags (OR / recall-first). */
  tags?: string[]
}

export interface QueryResult {
  results: NoteRef[]
  nextCursor: string | null
}

const HARD_CAP = 100

/** Queryable docs are the user-editable notes — `note`, `writing`, and wiki
 *  pages. `daily` journals and `system:*` pages don't carry user status/tags
 *  (matching the set_note_status / set_note_tags guards), so they're excluded. */
function inScope(doc: KnownDoc): boolean {
  return (
    doc.type === 'note' ||
    doc.type === 'writing' ||
    doc.type.startsWith('wiki:')
  )
}

/** Filter the catalog by metadata and return a page of references.
 *  Sort is newest-first with a slug tiebreak so `cursor` offsets are stable
 *  across calls within a session. */
export function queryNotes(
  docs: readonly KnownDoc[],
  where: NoteQuery,
  limit: number,
  cursor: string | null,
  getDoc: DocLookup,
): QueryResult {
  const wantTags = where.tags?.length ? normalizeTags(where.tags) : null

  const matched = docs.filter((doc) => {
    if (!inScope(doc)) return false
    if (where.status && doc.status !== where.status) return false
    if (wantTags) {
      const have = new Set(normalizeTags(doc.tags ?? []))
      if (!wantTags.some((t) => have.has(t))) return false
    }
    return true
  })

  matched.sort((a, b) => {
    const byDate = (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
    return byDate !== 0 ? byDate : a.slug.localeCompare(b.slug)
  })

  const offset = cursor ? Math.max(0, parseInt(cursor, 10) || 0) : 0
  const cap = Math.min(Math.max(1, limit), HARD_CAP)
  const page = matched.slice(offset, offset + cap)

  const results: NoteRef[] = []
  for (const doc of page) {
    const path = pathForDoc(doc, getDoc)
    if (!path) continue // unplaced (e.g. a daily-less writing) — no null paths reach the model
    results.push({
      path,
      title: doc.title?.trim() || path.split('/').pop()?.replace(/\.md$/, '') || path,
      status: doc.status ?? null,
      tags: doc.tags ?? [],
    })
  }

  const nextCursor = offset + cap < matched.length ? String(offset + cap) : null
  return { results, nextCursor }
}
