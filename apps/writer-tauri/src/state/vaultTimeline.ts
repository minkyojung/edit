// The time axis of the vault, to `wikiIndex.ts`'s space axis. Where the
// index answers "what exists, and where" (grouped by folder), the
// timeline answers "when did I make it" — every note listed by creation
// date, newest first, written to `_system/timeline.md`.
//
// Karpathy's log.md pattern: a running, system-owned ledger the LLM can
// Read to reconstruct chronology ("what was I working on last week",
// "what did I capture around the time I met X"). Deterministic from
// `knownDocs` — no LLM authoring, no drift.
//
// Second-brain principle (shared with the index): existence is
// guaranteed. A note with no recorded `createdAt` — a legacy or imported
// file — isn't dropped; it lands in an `Undated` bucket at the bottom so
// the LLM still knows it exists, just without a place on the timeline.
//
// Date source, in order: a `daily` note's own `date`; else the note's
// `createdAt` (ISO). We key on the ISO's leading `YYYY-MM-DD` (UTC) — a
// deterministic, timezone-independent, unit-testable slice. A note made
// late at night can land on the UTC day rather than the local one; for a
// personal chronology that imprecision is immaterial and the win is a
// pure function that behaves identically on every machine.

import { pathForDoc as computePathForDoc, type DocLookup } from '@/lib/docPaths'
import { writeVaultFile } from '@/lib/vault'
import { escapeMdCell } from './wikiIndex'
import { ensureTimelineWikiSlug } from './wikiService'
import { useDocsStore } from './docsStore'

/** Bucket label for notes without any resolvable creation date. Sorts
 * last (see {@link groupByDate}) so the dated stream reads top-down
 * newest-first with the undatable tail at the end. */
export const UNDATED = 'Undated'

/** Coalesce burst invalidations into a single disk write — same window
 * as the index. Short enough that the page stays current, long enough
 * that a create/rename burst collapses to one rebuild. */
const PERSIST_DEBOUNCE_MS = 200

/** Derive the timeline date key for a note.
 *
 *   1. A `daily` note's `date` is already `YYYY-MM-DD` — use it verbatim.
 *   2. Otherwise the note's `createdAt` ISO, sliced to its leading
 *      `YYYY-MM-DD` (UTC — see file header on the timezone tradeoff).
 *   3. Neither → {@link UNDATED}.
 *
 * Pure — exported for unit tests. */
export function dateKeyOf(doc: {
  type: string
  date?: string
  createdAt?: string
}): string {
  if (doc.type === 'daily' && doc.date && /^\d{4}-\d{2}-\d{2}$/.test(doc.date)) {
    return doc.date
  }
  if (doc.createdAt && /^\d{4}-\d{2}-\d{2}/.test(doc.createdAt)) {
    return doc.createdAt.slice(0, 10)
  }
  return UNDATED
}

/** One line on the timeline: a note's path (its address) + title. */
export interface TimelineEntry {
  path: string
  title: string
}

/** A day heading over the notes created that day. */
export interface TimelineDay {
  date: string
  entries: TimelineEntry[]
}

/** A note normalized for grouping: its date key, a sort key (the raw
 * `createdAt`, for stable newest-first ordering within a day), and the
 * display fields. */
export interface TimelineRow {
  dateKey: string
  createdAt: string
  path: string
  title: string
}

/** Group rows into days, ordered newest-first, with {@link UNDATED}
 * always last. Within a day, notes sort by `createdAt` descending
 * (newest first), breaking ties on title so the output is stable
 * (identical input → identical file, no churn between rebuilds). Pure. */
export function groupByDate(rows: TimelineRow[]): TimelineDay[] {
  const byDay = new Map<string, TimelineRow[]>()
  for (const r of rows) {
    let list = byDay.get(r.dateKey)
    if (!list) {
      list = []
      byDay.set(r.dateKey, list)
    }
    list.push(r)
  }

  const days: TimelineDay[] = [...byDay.entries()].map(([date, dayRows]) => ({
    date,
    entries: dayRows
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) {
          // Descending: the larger ISO string is the more recent time.
          return a.createdAt < b.createdAt ? 1 : -1
        }
        return a.title.localeCompare(b.title)
      })
      .map((r) => ({ path: r.path, title: r.title })),
  }))

  return days.sort((a, b) => {
    if (a.date === UNDATED) return 1
    if (b.date === UNDATED) return -1
    // Descending date: the later day comes first.
    return a.date < b.date ? 1 : -1
  })
}

/** Render grouped days to the markdown body of `_system/timeline.md`:
 * a `## YYYY-MM-DD` heading per day over a bullet per note
 * (`` - `path` — Title ``). No cap — every note appears (existence
 * guarantee). Empty vault → a placeholder line. */
export function renderTimeline(days: TimelineDay[]): string {
  if (days.length === 0) return '_No notes yet._'
  return days
    .map((d) => {
      const bullets = d.entries
        .map((e) => `- \`${escapeMdCell(e.path)}\` — ${escapeMdCell(e.title)}`)
        .join('\n')
      return `## ${escapeMdCell(d.date)}\n\n${bullets}`
    })
    .join('\n\n')
}

/** Filename (title fallback) for a note whose `KnownDoc.title` is empty
 * — e.g. a `daily` doc. The path basename minus `.md`. */
function basenameNoExt(path: string): string {
  const name = path.split('/').pop() ?? path
  return name.replace(/\.md$/, '')
}

/** Assemble the whole-vault timeline — every non-archived, non-system
 * note grouped by creation date, newest first. Deterministic snapshot
 * from live state, mirroring the index's catalog scope so the two
 * derived views stay consistent about which notes "count". */
export async function buildVaultTimeline(): Promise<string> {
  const catalog = useDocsStore.getState().knownDocs
  const getDoc: DocLookup = (slug) => catalog.find((d) => d.slug === slug)
  const indexed = catalog.filter(
    (d) => !d.archivedAt && !d.type.startsWith('system:'),
  )

  const rows: TimelineRow[] = []
  for (const doc of indexed) {
    const path = computePathForDoc(doc, getDoc)
    if (!path) continue
    rows.push({
      dateKey: dateKeyOf(doc),
      createdAt: doc.createdAt ?? '',
      path,
      title: (doc.title ?? '').trim() || basenameNoExt(path),
    })
  }

  return renderTimeline(groupByDate(rows))
}

// ── Memory cache ──────────────────────────────────────────────────
// Same shape as the index cache: last-built string + de-duped in-flight
// build, invalidated explicitly by the note-change call sites.

let cached: string | null = null
let inFlight: Promise<string> | null = null

/** Get the current timeline, building + caching on the first call after
 * each invalidation. Concurrent calls share one in-flight build. */
export async function getVaultTimeline(): Promise<string> {
  if (cached !== null) return cached
  if (inFlight) return inFlight
  inFlight = buildVaultTimeline()
    .then((result) => {
      cached = result
      return result
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/** Drop the cached timeline and schedule a debounced disk persist.
 * Called wherever the note set changes (create / delete / rename /
 * archive). Body edits don't move the timeline, so the persist guards
 * against a redundant write below. */
export function invalidateVaultTimeline(): void {
  cached = null
  scheduleTimelinePersist()
}

// ── Disk persistence (system-owned page) ────────────────────────
// Mirrors the index persist, plus a content-equality guard: the
// timeline is invalidated on the same broad note-change triggers as the
// index, but a plain body edit never changes the timeline's output — the
// guard skips the disk write (and its watcher echo + git churn) when the
// freshly-built body matches what we last wrote.

let persistTimer: ReturnType<typeof setTimeout> | null = null
let lastPersisted: string | null = null

function scheduleTimelinePersist(): void {
  if (persistTimer !== null) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    void persistTimelineNow().catch((err) => {
      console.warn('[timeline] persist failed', err)
    })
  }, PERSIST_DEBOUNCE_MS)
}

/** Rebuild + write the timeline page body to disk now. Idempotent.
 * Lazy-creates the `system:timeline` entry on first call so a freshly-
 * mounted vault needs no separate bootstrap step. */
async function persistTimelineNow(): Promise<void> {
  let doc = useDocsStore
    .getState()
    .knownDocs.find((d) => d.type === 'system:timeline' && !d.archivedAt)
  if (!doc) {
    await ensureTimelineWikiSlug()
    doc = useDocsStore
      .getState()
      .knownDocs.find((d) => d.type === 'system:timeline' && !d.archivedAt)
    if (!doc) return // ensure failed; next tick retries
  }

  const path = computePathForDoc(doc)
  if (!path) return

  const content = await getVaultTimeline()
  // Skip the write when nothing the timeline cares about changed — a
  // body edit invalidates us but yields identical output.
  if (content === lastPersisted) return
  await writeVaultFile(path, content + '\n')
  lastPersisted = content

  const docs = useDocsStore.getState()
  if (docs.handles[doc.slug]) {
    void docs.reloadFromVault(doc.slug)
  }
}
