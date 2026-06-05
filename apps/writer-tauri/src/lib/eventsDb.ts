// Thin invoke wrappers for the rust events commands in
// `src-tauri/src/events/`.
//
// `events.db` is the common-envelope store for external structured data
// (GitHub commits/PRs first). It lives in the per-device app-data dir (NOT
// the vault), so the synced vault stays a clean folder of user files and rust
// resolves the path itself — these wrappers no longer pass a vault path.
// They still no-op (return 0 / []) before a vault is picked, so they're safe
// to call during onboarding.

import { invoke } from '@tauri-apps/api/core'
import { getActiveVaultPath } from '@/state/settingsStore'

/** The common envelope. Shape matches the rust `Entry` struct
 * (camelCase via serde rename). The outside is fixed; `payload` holds
 * the provider's raw response verbatim. */
export interface Entry {
  /** Stable dedup key, e.g. `github:commit:<sha>`. */
  id: string
  /** ISO8601 event time — the spine for ordering/aggregation. */
  ts: string
  /** ISO8601 ingest time — separate from `ts` for backfill/lag. */
  ingestedAt: string
  source: string
  kind: string
  summary: string
  entities: string[]
  refs: string[]
  /** Provider's raw response, stored verbatim. */
  payload: unknown
}

/** Optional filters for `eventsQuery`. Omitted fields are unconstrained.
 * Mirrors the rust `EventFilter` struct. */
export interface EventFilter {
  fromTs?: string
  toTs?: string
  source?: string
  kind?: string
  limit?: number
}

/** UPSERT events by `id` (idempotent — re-importing overwrites in place).
 * Returns the number processed, or 0 when there's no active vault. */
export async function eventsInsert(entries: Entry[]): Promise<number> {
  const vault = getActiveVaultPath()
  if (!vault) return 0
  return invoke<number>('events_insert', { entries })
}

/** Query events with optional filters, newest first. Empty array when
 * there's no active vault. */
export async function eventsQuery(filter: EventFilter = {}): Promise<Entry[]> {
  const vault = getActiveVaultPath()
  if (!vault) return []
  return invoke<Entry[]>('events_query', { filter })
}

/** Events whose `ts` falls on the given local day (YYYY-MM-DD), newest
 * first. Used by the daily GitHub-activity card.
 *
 * Matches by string range on the ISO `ts`. GitHub commit dates carry a
 * local offset (e.g. `…T15:39:54+09:00`), so the date prefix lines up
 * with a same-timezone daily note. Mixed-offset sources could land a
 * boundary event on the neighbouring day — acceptable for v1. */
export async function eventsQueryByDate(date: string): Promise<Entry[]> {
  return eventsQuery({
    fromTs: `${date}T00:00:00`,
    toTs: `${date}T23:59:59.999999`,
  })
}

/** Full-text search over event summaries, newest first. Empty array when
 * there's no active vault. */
export async function eventsSearch(
  query: string,
  limit = 50,
): Promise<Entry[]> {
  const vault = getActiveVaultPath()
  if (!vault) return []
  return invoke<Entry[]>('events_search', { query, limit })
}
