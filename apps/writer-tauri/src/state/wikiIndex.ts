// Tier 1 of the context engineering pipeline — a system-generated
// catalog of every wiki page, one line per page, kept fresh by the
// vault dirty/flush cycle.
//
// Replaces the prior ingest-edited `wiki:index` page: the LLM used to
// re-author that page on every ingest pass, which was both expensive
// (extra tokens per pass) and drift-prone (the model would sometimes
// drop a line or invent a slug). The catalog now comes straight from
// `knownDocs` + sidecars + body backlink counts — deterministic, free,
// always current.
//
// Three responsibilities:
//   1. countBacklinks — how many other wiki pages link to each target
//      (used as the `linked: N` column in the index line).
//   2. buildWikiIndex — assemble the full catalog string (this file's
//      reason to exist; next sub-step).
//   3. getWikiIndex + invalidateWikiIndex — memory cache so chat /
//      lint / ingest can grab the catalog cheaply between vault
//      changes (next sub-step).
//
// Pure functions only here; the I/O side (reading bodies / writing
// the persisted `wiki:index` file) lives in the buildWikiIndex layer
// added in the next sub-step.

import type { KnownDoc } from './docsStore'
import { extractWikilinks } from '@/lib/wikilinkResolve'
import { isEffectivelyEmpty } from '@/lib/markdownText'
import { ensureIndexWikiSlug, readWikiMarkdown } from './wikiService'
import {
  metaPathForDoc,
  pathForDoc as computePathForDoc,
  type DocMetaFile,
} from '@/lib/docPaths'
import {
  readVaultFile,
  vaultFileExists,
  writeVaultFile,
} from '@/lib/vault'
import { useDocsStore } from './docsStore'

const SUMMARY_MAX_LEN = 80
const EMPTY_PLACEHOLDER = '(empty)'
/** Coalesce burst invalidations (e.g. multi-page flush, watcher
 * batch) into a single disk write. 200ms is short enough that the
 * `_system/index.md` page stays visually current as the user edits,
 * long enough that a typing burst across multiple wiki pages
 * collapses to one rebuild + write. */
const PERSIST_DEBOUNCE_MS = 200

/** Count how many non-archived wiki / daily / writing docs link
 * back to each wiki target via `[[Title]]` references in body
 * markdown.
 *
 * Inputs:
 *   - `catalog`: the live `knownDocs` slice (every doc the app knows
 *     about, archived or not — we filter inline).
 *   - `bodyOf`: caller-provided lookup that returns each slug's
 *     markdown body (or null/undefined for pages with no readable
 *     body — those are skipped). Kept as a pluggable function rather
 *     than a `Map` so the caller can choose to lazy-read or pre-fetch.
 *
 * Returns: `Map<targetSlug, count>` keyed by the *target* slug. Only
 * slugs with at least one inbound link appear in the map; callers
 * should default missing entries to 0.
 *
 * Behaviour notes:
 * - `system:*` pages are excluded from the title → slug map (same
 *   filter as `resolveWikilinksInMarkdown`). The LLM is told never to
 *   link to schema/log/index pages, and an accidental `[[Conventions]]`
 *   should stay literal rather than count toward backlink stats.
 * - Archived docs are excluded as both source (their body) and target
 *   (their slug doesn't appear in titleToSlug). Restoring an archived
 *   doc re-introduces it on the next index rebuild.
 * - Self-references (a doc's body containing its own `[[Title]]`)
 *   don't count — that's almost always a typo or a paste from
 *   elsewhere, not a meaningful backlink.
 * - Case-insensitive title matching, matching the resolver. */
export function countBacklinks(
  catalog: KnownDoc[],
  bodyOf: (slug: string) => string | null | undefined,
): Map<string, number> {
  // Build title → slug lookup. Same filter as resolveWikilinksInMarkdown:
  // archived + system:* pages don't participate in linking.
  const titleToSlug = new Map<string, string>()
  for (const doc of catalog) {
    if (doc.archivedAt) continue
    if (doc.type.startsWith('system:')) continue
    const title = (doc.title ?? '').trim()
    if (!title) continue
    const key = title.toLowerCase()
    // First match wins on collisions — single-user wikis almost never
    // see this, and arbitrary winner is fine for stats (the resolver
    // picks the same winner so counts stay self-consistent).
    if (!titleToSlug.has(key)) titleToSlug.set(key, doc.slug)
  }

  const counts = new Map<string, number>()
  for (const doc of catalog) {
    if (doc.archivedAt) continue
    const body = bodyOf(doc.slug)
    if (!body) continue
    const tokens = extractWikilinks(body)
    for (const token of tokens) {
      const targetSlug = titleToSlug.get(token.toLowerCase())
      if (!targetSlug) continue
      if (targetSlug === doc.slug) continue // skip self-references
      counts.set(targetSlug, (counts.get(targetSlug) ?? 0) + 1)
    }
  }
  return counts
}

/** Read a wiki doc's `.meta.json` sidecar and return the parsed
 * payload. Returns null when the file doesn't exist or doesn't parse
 * — the caller falls back to body-derived fields. */
async function readWikiSidecar(doc: KnownDoc): Promise<Partial<DocMetaFile> | null> {
  const path = metaPathForDoc(doc)
  if (!path) return null
  if (!(await vaultFileExists(path))) return null
  try {
    const raw = await readVaultFile(path)
    return JSON.parse(raw) as Partial<DocMetaFile>
  } catch {
    return null
  }
}

/** Pull a one-line excerpt suitable for the index summary column.
 * Bear/Obsidian convention: the body's first non-empty line IS the
 * title. The index already shows the title separately, so we skip
 * that line and use the next content line as the actual summary.
 * Returns null when the body has zero or one non-empty lines.
 *
 * Exported for unit tests — the title-skip rule is the public
 * contract between body shape and index summary quality. */
export function bodyExcerpt(body: string): string | null {
  let foundFirst = false
  for (const line of body.split('\n')) {
    if (isEffectivelyEmpty(line)) continue
    if (!foundFirst) {
      foundFirst = true
      continue
    }
    return line.trim()
  }
  return null
}

/** Truncate `text` to at most `max` characters, appending `…` when a
 * cut happened. Used to keep index lines on a single visual row even
 * when a summary went long. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max).trimEnd() + '…'
}

/** Assemble the Tier 1 wiki catalog — one row per non-archived wiki
 * page, rendered as a markdown table. Replaces the prior LLM-edited
 * `wiki:index` body with a fresh, deterministic snapshot.
 *
 * Table format:
 *   | Path | Type | Title | Summary | Links |
 *   |------|------|-------|---------|-------|
 *   | wiki/Sarah.md | wiki:custom-7n2... | Sarah | Senior engineer... | 3 |
 *
 * The path comes first because that's what the LLM needs to feed
 * back into the `read_page` / `search_wiki` tools. The Type column
 * carries the verbatim type-id the ingest LLM reads when constructing
 * a proposal's `target` — without it the model has no way to address
 * an existing page (file paths and titles aren't stable identifiers
 * across renames; type ids are). Title + Summary follow for
 * human-readable scanning; Links is the backlink count.
 *
 * Why a table (not a bullet list, as it used to be):
 * the body is a list of records, and tables align columns so the
 * user can scan dozens of pages at a glance. The LLM also still
 * reads it fine — markdown table is a standard format. The editor
 * renders it as a real PM table (Milkdown GFM preset).
 *
 * Source preference for each column:
 *   - Path   : pathForDoc(doc) → e.g. `wiki/Sarah Kim.md`
 *   - Type   : `KnownDoc.type` → e.g. `wiki:custom-7n2dvj41`
 *   - Title  : `KnownDoc.title` (Bear/Obsidian first-body-line)
 *   - Summary: `sidecar.aiSummary` (populated by Phase A5 ingest hook)
 *              → fallback to the body's first content line after the
 *                title (see {@link bodyExcerpt})
 *              → fallback to `(empty)` placeholder so the LLM still
 *                sees that the page exists
 *   - Links  : backlink count from {@link countBacklinks}
 *
 * Pages without a resolvable path (shouldn't happen for non-archived
 * wiki entries, but defensive) are skipped silently. */
export async function buildWikiIndex(): Promise<string> {
  const catalog = useDocsStore.getState().knownDocs
  const wikiPages = catalog.filter(
    (d) => d.type.startsWith('wiki:') && !d.archivedAt,
  )

  // Pre-fetch bodies + sidecars. Bodies come from in-memory handles
  // (sync); sidecars are tiny JSON files read in parallel.
  const bodies: Record<string, string> = {}
  for (const d of wikiPages) {
    bodies[d.slug] = readWikiMarkdown(d.slug)
  }
  const sidecars = await Promise.all(wikiPages.map((d) => readWikiSidecar(d)))

  const counts = countBacklinks(catalog, (slug) => bodies[slug])

  const rows: string[] = [
    '| Path | Type | Title | Summary | Links |',
    '|------|------|-------|---------|-------|',
  ]
  for (let i = 0; i < wikiPages.length; i++) {
    const doc = wikiPages[i]
    const path = computePathForDoc(doc)
    if (!path) continue
    const sidecar = sidecars[i]
    const body = bodies[doc.slug] ?? ''
    const summary =
      sidecar?.aiSummary?.trim() ||
      bodyExcerpt(body) ||
      EMPTY_PLACEHOLDER
    const title = (doc.title ?? '').trim() || 'Untitled'
    const linked = counts.get(doc.slug) ?? 0
    rows.push(
      `| ${escapeMdCell(path)} | ${escapeMdCell(doc.type)} | ${escapeMdCell(title)} | ${escapeMdCell(truncate(summary, SUMMARY_MAX_LEN))} | ${linked} |`,
    )
  }
  return rows.join('\n')
}

/** Escape a value for safe placement inside a markdown table cell.
 * Replaces pipe characters with `\|` (which most renderers parse as
 * a literal `|`) and collapses newlines to spaces — markdown table
 * cells can't carry line breaks without specialised extensions, so
 * a title or summary containing `\n` would otherwise split the row. */
function escapeMdCell(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim()
}

// ── Memory cache ──────────────────────────────────────────────────
//
// `buildWikiIndex` walks the entire catalog + reads every sidecar on
// every call. That's cheap at 10 pages but becomes wasteful when chat
// / ingest / lint each fetch the index multiple times per call
// without anything having changed.
//
// The cache holds the last-built string and an in-flight promise
// (de-duped concurrent rebuilds). Invalidation is driven by callers
// who know "something the index depends on changed" — wiki page
// flushes, external vault edits to wiki paths, bootstrap completion.
//
// No expiry / TTL — the cache stays valid until something explicitly
// invalidates it. A future "fallback safety net" could add a
// stale-after timer, but for now we trust the explicit invalidation
// points because their failure modes (missing a wiki edit) are
// loud (sidebar diverges from index) and so easy to catch.

let cached: string | null = null
let inFlight: Promise<string> | null = null

/** Get the current Tier 1 wiki index, building + caching it on the
 * first call after each invalidation. Concurrent calls share the
 * same in-flight build so we don't read every sidecar N times when
 * chat + ingest fire back-to-back. */
export async function getWikiIndex(): Promise<string> {
  if (cached !== null) return cached
  if (inFlight) return inFlight
  inFlight = buildWikiIndex()
    .then((result) => {
      cached = result
      return result
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/** Drop the cached index so the next `getWikiIndex()` call rebuilds
 * from scratch, and schedule a debounced disk persist so the
 * user-visible `_system/index.md` page stays current.
 *
 * Callers: any code path that changes the data the index depends on
 * (wiki page body + sidecar). Cheap — just clears a reference; the
 * rebuild + disk write happen lazily inside the debounce window. */
export function invalidateWikiIndex(): void {
  cached = null
  scheduleWikiIndexPersist()
}

// ── Disk persistence (system-owned page) ────────────────────────
//
// Karpathy's index.md pattern with a twist: instead of an LLM editing
// the page mid-ingest (the pre-2026-05-19 model), the system is the
// single writer. We assemble the catalog deterministically and write
// it as the body of the `system:index` page. The page is therefore
// always fresh, always parseable by the LLM, and never drifts from
// what the catalog actually contains.
//
// User edits to `_system/index.md` are tolerated but transient — the
// next invalidation overwrites them. That's the contract: the page
// is a read surface, not a user-authored one. Sidebar users see the
// freshest possible catalog at all times.
//
// Echo handling: writeVaultFile stamps `markOurRecentWrite` so the
// vault watcher's filter (vaultWatcher.ts:81) drops our own write
// from the dispatch step. No invalidation loop.

let persistTimer: ReturnType<typeof setTimeout> | null = null

function scheduleWikiIndexPersist(): void {
  if (persistTimer !== null) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    void persistWikiIndexNow().catch((err) => {
      console.warn('[wiki:index] persist failed', err)
    })
  }, PERSIST_DEBOUNCE_MS)
}

/** Rebuild + write the index page body to disk now. Idempotent; safe
 * to call directly (tests, manual dev-console refresh) outside the
 * debounce. Lazy-creates the `system:index` catalog entry on first
 * call so a freshly-mounted vault doesn't need a separate bootstrap
 * step to register the page. */
async function persistWikiIndexNow(): Promise<void> {
  let indexDoc = useDocsStore
    .getState()
    .knownDocs.find((d) => d.type === 'system:index' && !d.archivedAt)
  if (!indexDoc) {
    await ensureIndexWikiSlug()
    indexDoc = useDocsStore
      .getState()
      .knownDocs.find((d) => d.type === 'system:index' && !d.archivedAt)
    if (!indexDoc) return // ensure failed; bail and let next tick retry
  }

  const path = computePathForDoc(indexDoc)
  if (!path) return

  const content = await getWikiIndex()
  // Trailing newline keeps the file POSIX-friendly when viewed via
  // CLI / git diff; the parser doesn't care either way.
  await writeVaultFile(path, content + '\n')

  // If the page is currently loaded into a Y.Doc (user has it open
  // or it was lazy-warmed earlier), refresh the in-memory copy from
  // the just-written body so the editor reflects the new catalog.
  // Skipped when the handle hasn't been built — the next ensureHandle
  // hydrates from the file naturally.
  const docs = useDocsStore.getState()
  if (docs.handles[indexDoc.slug]) {
    void docs.reloadFromVault(indexDoc.slug)
  }
}
