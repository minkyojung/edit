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
import { readWikiMarkdown } from './wikiService'
import { metaPathForDoc, type DocMetaFile } from '@/lib/docPaths'
import { readVaultFile, vaultFileExists } from '@/lib/vault'
import { useDocsStore } from './docsStore'

const SUMMARY_MAX_LEN = 80
const EMPTY_PLACEHOLDER = '(empty)'

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

/** Assemble the Tier 1 wiki catalog — one line per non-archived wiki
 * page. Replaces the prior LLM-edited `wiki:index` body with a fresh,
 * deterministic snapshot.
 *
 * Line format: `- [<slug>] <title> — <summary> | linked: <N>`
 *
 * Source preference for each column:
 *   - title  : `KnownDoc.title` (Bear/Obsidian first-body-line)
 *   - summary: `sidecar.aiSummary` (populated by Phase A5 ingest hook)
 *              → fallback to the body's first content line after the
 *                title (see {@link bodyExcerpt})
 *              → fallback to `(empty)` placeholder so the LLM still
 *                sees that the page exists
 *   - linked : backlink count from {@link countBacklinks}
 *
 * Pure side-effect-free aside from sidecar reads. The memory-cache
 * layer + disk persistence land in the next sub-step. */
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

  const lines = wikiPages.map((doc, i) => {
    const sidecar = sidecars[i]
    const body = bodies[doc.slug] ?? ''
    const summary =
      sidecar?.aiSummary?.trim() ||
      bodyExcerpt(body) ||
      EMPTY_PLACEHOLDER
    const title = (doc.title ?? '').trim() || 'Untitled'
    const linked = counts.get(doc.slug) ?? 0
    return `- [${doc.slug}] ${title} — ${truncate(summary, SUMMARY_MAX_LEN)} | linked: ${linked}`
  })

  return lines.join('\n')
}
