// Merging the fetched model catalog with the built-in list.
//
// Two sources, deliberately unequal:
//   • the CATALOG (GET /v1/models, via the anthropic_list_models command) is
//     authoritative and current — it carried Opus 5 on release day, when both
//     the SDK handshake and the CLI's `opus` alias still said 4.8;
//   • the SEED (CHAT_MODELS) is what this build shipped with, and is the only
//     thing available offline or before login.
//
// The merge is a UNION and never a replacement. A failed or empty fetch can
// therefore only fail to ADD a model — it can never remove one the user is
// already on, which is the property that makes wiring this in safe.
//
// Kept as a pure function (no store, no IPC) so the collision and ordering
// rules below are testable without a running app.

import { CHAT_EFFORTS, type ChatEffort } from '@/chat/types'
import { familyKey } from '@/chat/modelFacts'

export { familyKey }

/** One catalog row, mirroring the Rust `ModelEntry` (serde camelCase). */
export interface ModelEntry {
  id: string
  displayName: string
  createdAt?: string
  maxInputTokens?: number
  maxTokens?: number
  efforts: string[]
}

export interface MergedModel {
  /** The id to SEND to the sidecar. On a collision this is the seed's spelling
   * (see `familyKey`), because that's the one already persisted in threads and
   * proven to serve. */
  id: string
  displayName?: string
  createdAt?: string
  maxInputTokens?: number
  /** Effort tiers, narrowed to the ones this app exposes. Undefined when the
   * catalog didn't cover this model, so callers keep their built-in table. */
  efforts?: readonly ChatEffort[]
  /** False for a model only the built-in list knows — either the fetch failed,
   * or the account can't see it. */
  inCatalog: boolean
}

/** Catalog efforts are plain strings and may include tiers we deliberately
 * don't expose (`max` — its token/time cost is disproportionate for a writing
 * tool, see ChatEffort). Narrow, preserving the catalog's ascending order. */
function narrowEfforts(efforts: string[] | undefined): readonly ChatEffort[] | undefined {
  if (!efforts || efforts.length === 0) return undefined
  const kept = efforts.filter((e): e is ChatEffort =>
    (CHAT_EFFORTS as readonly string[]).includes(e),
  )
  return kept.length > 0 ? kept : undefined
}

/** Newest first, so a freshly released model surfaces at the top of the picker
 * without anyone curating an order. Entries with no `createdAt` (seed-only)
 * sort last but keep their relative order — that's the hand-picked built-in
 * order, which is still the sensible fallback. */
function byNewestFirst(a: MergedModel, b: MergedModel): number {
  if (a.createdAt && b.createdAt) return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
  if (a.createdAt) return -1
  if (b.createdAt) return 1
  return 0
}

/**
 * Union of the built-in list and the fetched catalog.
 *
 * Collision rule: identity from the SEED, facts from the CATALOG. The seed's id
 * spelling is what threads already store and what has been serving, so changing
 * it would orphan saved threads for no gain; the catalog's display name,
 * context window and effort tiers are the fresher facts, so those win.
 */
export function mergeModelCatalog(
  seedIds: readonly string[],
  catalog: readonly ModelEntry[] | null | undefined,
): MergedModel[] {
  const byKey = new Map<string, ModelEntry>()
  for (const entry of catalog ?? []) {
    // First write wins: the catalog is newest-first, so an older dated variant
    // can't displace the current one.
    if (!byKey.has(familyKey(entry.id))) byKey.set(familyKey(entry.id), entry)
  }

  const merged: MergedModel[] = []
  const claimed = new Set<string>()

  // Seed first, so its id spelling is the one that survives a collision.
  for (const id of seedIds) {
    const key = familyKey(id)
    claimed.add(key)
    const hit = byKey.get(key)
    merged.push({
      id,
      displayName: hit?.displayName,
      createdAt: hit?.createdAt,
      maxInputTokens: hit?.maxInputTokens,
      efforts: narrowEfforts(hit?.efforts),
      inCatalog: hit !== undefined,
    })
  }

  // Then anything the catalog knows that this build doesn't — the whole point:
  // a model released after ship date shows up without a new binary.
  for (const [key, entry] of byKey) {
    if (claimed.has(key)) continue
    merged.push({
      id: entry.id,
      displayName: entry.displayName,
      createdAt: entry.createdAt,
      maxInputTokens: entry.maxInputTokens,
      efforts: narrowEfforts(entry.efforts),
      inCatalog: true,
    })
  }

  return merged.sort(byNewestFirst)
}

// ── Version floor ─────────────────────────────────────────────────────────────
//
// The catalog reaches back further than this app should offer. Opus 4.1 is the
// clearest case: it's still listed, but asking for it returns a successful turn
// written by Opus 4.8 — the picker would be naming a model that never answers.
//
// A per-family MINIMUM handles that without a hand-maintained allowlist: it
// names a floor once, and every future release clears it automatically. The
// alternative — listing every model we accept — is the exact thing this whole
// change set exists to delete.

/** Lowest version offered per family. A family absent here has no floor: an
 * unrecognized family must never be hidden, or the next new line of models
 * disappears behind a rule written before it existed. */
const VERSION_FLOOR: Record<string, readonly number[]> = {
  opus: [4, 6],
  sonnet: [4, 6],
  haiku: [4, 5],
}

/** `claude-opus-4-8` → `{ family: 'opus', version: [4, 8] }`. Null for anything
 * that doesn't fit the current naming (including the old `claude-3-opus-…`
 * shape) — callers treat that as "no opinion", never as "hide". */
export function parseModelVersion(id: string): { family: string; version: number[] } | null {
  // Strip the release-date suffix FIRST: `claude-haiku-4-5-20251001` would
  // otherwise parse 20251001 as a third version segment.
  const m = /^claude-([a-z]+)-(\d+(?:-\d+)*)$/.exec(familyKey(id))
  if (!m) return null
  return { family: m[1], version: m[2].split('-').map(Number) }
}

/** Segment-wise comparison. NOT numeric: read as decimals, a future 4.10 would
 * sort below 4.8 (4.1 < 4.8) and silently drop a newer model. */
function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Is this model recent enough to offer? Unparseable ids and unknown families
 * pass — the default is always to show. */
export function meetsVersionFloor(id: string): boolean {
  const parsed = parseModelVersion(id)
  if (!parsed) return true
  const floor = VERSION_FLOOR[parsed.family]
  if (!floor) return true
  return compareVersions(parsed.version, floor) >= 0
}

/**
 * Split a merged list into what the picker shows up front and what it tucks
 * behind an "Older" heading.
 *
 * The catalog returns everything the account can reach — currently 11 models,
 * back to Opus 4.1 — and dumping all of them into the picker would bury the
 * three or four anyone actually uses. But nothing may be REMOVED (an old thread
 * pinned to an old model must stay selectable), so this demotes rather than
 * filters.
 *
 * Primary = anything this build ships with, plus anything NEWER than the newest
 * model it ships with. That second clause is the whole point: a model released
 * after ship date is exactly what should be surfaced, and it's the only thing
 * we can identify as "new" without a human curating a list. Everything older
 * that we didn't ship with is demoted.
 *
 * With no catalog every entry is seed-only and undated, so primary is the full
 * built-in list and `older` is empty — identical to the pre-catalog picker.
 */
export function splitByRecency(
  merged: readonly MergedModel[],
  seedIds: readonly string[],
): { primary: MergedModel[]; older: MergedModel[] } {
  const seed = new Set(seedIds.map(familyKey))
  const isSeed = (m: MergedModel) => seed.has(familyKey(m.id))

  // Newest release date among the models we ship with — the cutoff.
  let newestSeedDate: string | undefined
  for (const m of merged) {
    if (!isSeed(m) || !m.createdAt) continue
    if (!newestSeedDate || m.createdAt > newestSeedDate) newestSeedDate = m.createdAt
  }

  const primary: MergedModel[] = []
  const older: MergedModel[] = []
  for (const m of merged) {
    // Undated non-seed entries can't be proven newer, so they're demoted — the
    // conservative side of the guess (still reachable, just not up front).
    const isNewer = newestSeedDate !== undefined && m.createdAt !== undefined && m.createdAt > newestSeedDate
    ;(isSeed(m) || isNewer ? primary : older).push(m)
  }
  return { primary, older }
}
