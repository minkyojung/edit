// Tier 2 of the context engineering pipeline — "hot context".
//
// Given a source (a daily body for lint/ingest, or a user query for
// chat), return the wiki pages most likely to be relevant: their
// title + full body, capped by a character budget so the system
// prompt stays small enough to cache cheaply.
//
// Signal: explicit `[[Title]]` wikilinks. Plain-text mentions are
// intentionally NOT supported in v1 — they pull in too much noise
// when entity names happen to coincide with common words ("Notes",
// "Open", "Today"). The ingest prompt tells the LLM to wrap real
// references in brackets; user-written dailies that lack brackets
// stay out of hot context until the user (or a future Phase D
// mention-extractor) routes them in.
//
// Tie-breaking: when hot candidates would exceed the budget, drop
// the lowest-rank pages first. Rank = inbound backlink count from
// {@link countBacklinks} — popular pages stay, niche ones fall off.
// Partial-body truncation is NOT used; the LLM is better served by
// fewer complete pages than many half-included ones.
//
// Pure / testable: the core logic takes catalog + bodyOf as args
// (same pattern as countBacklinks). The exported `selectHotPages`
// is a thin wrapper that pulls those from the live docsStore +
// readWikiMarkdown.

import type { KnownDoc } from '@/state/docsStore'
import { useDocsStore } from '@/state/docsStore'
import { extractWikilinks } from '@/lib/wikilinkResolve'
import { readWikiMarkdown } from '@/state/wikiService'
import { countBacklinks } from '@/state/wikiIndex'

/** Default character budget for the hot-pages section of the system
 * prompt. ~30K chars ≈ 7K tokens — leaves headroom for index (Tier
 * 1) + conventions + the user prompt without overflowing the cache
 * window. Callers (lint, chat with shorter budget needs) override. */
const DEFAULT_BUDGET_CHARS = 30_000

export interface WikiPageBody {
  slug: string
  title: string
  body: string
}

export interface SelectHotPagesSource {
  /** Markdown of a doc the LLM is acting on (lint: the daily being
   * reviewed; ingest: the daily being ingested). Wikilinks here
   * surface their target pages as hot context. */
  dailyBody?: string
  /** User chat query. Wikilinks the user typed in `[[Foo]]` form
   * surface Foo's page. Mutually exclusive with dailyBody in
   * practice; both being present just means we extract from both
   * concatenated. */
  queryText?: string
}

export interface SelectHotPagesOptions {
  budgetChars?: number
}

/** Pure version — accepts catalog + body reader as args so tests
 * can run without zustand / live state. The public {@link selectHotPages}
 * wraps this with the live store. */
export function selectHotPagesFrom(
  source: SelectHotPagesSource,
  catalog: KnownDoc[],
  bodyOf: (slug: string) => string,
  opts: SelectHotPagesOptions = {},
): WikiPageBody[] {
  const budget = opts.budgetChars ?? DEFAULT_BUDGET_CHARS
  const sourceText = [source.dailyBody ?? '', source.queryText ?? '']
    .join('\n')
    .trim()
  if (!sourceText) return []

  // Title → slug, case-insensitive, skipping archived + system:* (same
  // filter the resolver uses; keeps signal aligned with what the LLM
  // sees as linkable in the wiki context).
  const titleToSlug = new Map<string, string>()
  for (const doc of catalog) {
    if (doc.archivedAt) continue
    if (doc.type.startsWith('system:')) continue
    const t = (doc.title ?? '').trim().toLowerCase()
    if (!t) continue
    if (!titleToSlug.has(t)) titleToSlug.set(t, doc.slug)
  }

  // Extract every [[...]] reference, resolve to slug, dedupe.
  // `Set` collapses `[[Sarah]] / [[sarah]] / [[Sarah Kim]]` (when
  // they resolve to the same page) into one hot-page entry.
  const candidateSlugs = new Set<string>()
  for (const token of extractWikilinks(sourceText)) {
    const slug = titleToSlug.get(token.toLowerCase())
    if (slug) candidateSlugs.add(slug)
  }
  if (candidateSlugs.size === 0) return []

  // Score each candidate by backlink count (rank tie-breaker only —
  // when budget cuts in, the more-referenced pages survive). One
  // countBacklinks call walks every body; that's acceptable at the
  // moderate scale we target (Karpathy 100-page heuristic). If this
  // becomes a hot path later, share the count map with the Tier 1
  // index cache.
  const counts = countBacklinks(catalog, bodyOf)
  const candidates: Array<{
    slug: string
    title: string
    body: string
    rank: number
  }> = []
  for (const slug of candidateSlugs) {
    const doc = catalog.find((d) => d.slug === slug)
    if (!doc) continue
    const body = bodyOf(slug)
    if (!body) continue // unloaded handle / empty page — nothing to feed
    candidates.push({
      slug,
      title: (doc.title ?? '').trim() || 'Untitled',
      body,
      rank: counts.get(slug) ?? 0,
    })
  }

  // Sort descending by rank so the top candidates fit within budget
  // first. Stable-sort on slug as a secondary key would let tests pin
  // ordering, but JS's sort is stable by default — we lean on that
  // rather than introducing a tie-break that callers can't predict.
  candidates.sort((a, b) => b.rank - a.rank)

  // Whole-page inclusion only. A page either fits within remaining
  // budget or doesn't — partial bodies confuse the LLM more than
  // dropped pages do.
  const result: WikiPageBody[] = []
  let used = 0
  for (const c of candidates) {
    if (used + c.body.length > budget) continue
    used += c.body.length
    result.push({ slug: c.slug, title: c.title, body: c.body })
  }
  return result
}

/** Live-state wrapper. Async because future versions may fall back
 * to disk reads for wiki pages whose Y.Doc handle hasn't been
 * warmed yet; for now the body reader is sync and the await is
 * pro forma. */
export async function selectHotPages(
  source: SelectHotPagesSource,
  opts?: SelectHotPagesOptions,
): Promise<WikiPageBody[]> {
  const catalog = useDocsStore.getState().knownDocs
  return selectHotPagesFrom(source, catalog, readWikiMarkdown, opts)
}
