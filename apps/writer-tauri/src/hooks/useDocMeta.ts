// Doc-meta helpers — type + local-date utilities.
//
// Phase 5c of the Yjs-removal migration retired the Y.Map-backed
// `readDocMeta` / `writeDocMeta` pair. `type` / `date` / `parentId`
// are path-derived in scanVault, and `createdAt` lives directly on
// the `KnownDoc` catalog (serialised into `.meta.json` by the flush
// loop). What remains here is the shared `DocType` union the catalog
// uses + the local-date helpers calendar surfaces depend on.

// `system:*` = agent meta surface (conventions / log / index) read /
// maintained on dedicated prompt channels. `wiki:*` = agent-managed
// content pages (`wiki:custom-...`) the user accumulates. Both are
// distinct from user-authored `daily` / `writing` so archive /
// delete guards and sidebar grouping can branch on a single field.
// See KnownDoc.type doc in docsStore.ts for the schema-vs-wiki
// rationale (Karpathy split applied to our catalog).
export type DocType = 'daily' | 'writing' | `system:${string}` | `wiki:${string}`

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
