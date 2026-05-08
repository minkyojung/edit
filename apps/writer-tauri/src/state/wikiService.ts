// Wiki bootstrap — Karpathy LLM Wiki structure on top of proof-sdk.
//
// Karpathy's pattern is "schema comes from the user" — the agent
// maintains pages but doesn't dictate their categories. We translate
// that here as a hybrid: three opinionated seeds (belief / entity /
// episode) ship on first launch so a new user has somewhere to start,
// and `createCustomWikiPage` lets them grow the wiki with arbitrary
// pages of their own (`wiki:custom-<id>`). The chat runner reads
// every wiki:* doc in the catalog and prepends them as the cacheable
// prefix of the system prompt.
//
// Future (P3 / Memory-writer) will let a background agent edit these
// pages with provenance. For now, the user edits them by hand from
// the sidebar Wiki section.

import { proofClient } from '@/lib/proofClient'
import { detectShape } from '@/agent/wikiShape'
import { useDocsStore, type KnownDoc } from './docsStore'

const PROOF_BASE_URL = 'http://localhost:4000'

/** Seed wiki pages that bootstrap on first launch. Order is meaningful
 * — these appear first in the chat system prompt and at the top of
 * the sidebar wiki section. Custom pages (created via the + button)
 * follow them in creation order.
 *
 * `pinToEnd` seeds (today: just `wiki:log`) live at the very end of
 * the prompt regardless of order here — they hold high-churn content
 * (Karpathy's append-only timeline) that would invalidate cache hits
 * for everything below it if placed earlier.
 *
 * `tailLines` caps the per-section body to the last N non-empty
 * lines. log.md grows unbounded over time; without this cap the
 * prompt would slowly bloat and the cache prefix above it would
 * still get invalidated on every append. */
const WIKI_SEEDS = [
  { type: 'wiki:belief', title: 'belief', heading: 'BELIEFS' },
  { type: 'wiki:entity', title: 'entity', heading: 'ENTITIES' },
  { type: 'wiki:episode', title: 'episode', heading: 'EPISODES' },
  {
    type: 'wiki:log',
    title: 'log',
    heading: 'TIMELINE',
    pinToEnd: true,
    tailLines: 30,
  },
] as const

type SeedType = (typeof WIKI_SEEDS)[number]['type']

/** Ensure each seed wiki type has a doc in the catalog. Idempotent.
 * Called from docsStore.bootstrap as fire-and-forget — chat reads
 * wiki content lazily so the first paint isn't blocked on these
 * round-trips. Custom user-created pages are NOT recreated here;
 * those live solely off of explicit createCustomWikiPage calls. */
export async function ensureWikiDocs(): Promise<void> {
  for (const def of WIKI_SEEDS) {
    await ensureSeedDoc(def.type, def.title).catch((err) =>
      console.error(`[wiki] ensure ${def.type} failed`, err),
    )
  }
}

async function ensureSeedDoc(
  type: SeedType,
  title: string,
): Promise<string | null> {
  const existing = useDocsStore
    .getState()
    .knownDocs.find((d) => d.type === type)
  if (existing) return existing.slug
  try {
    // ZWS body so the proof-server's blank-markdown guard accepts it.
    // The user's content grows from here — empty until they write.
    const created = await proofClient.createDoc(title, '​')
    const meta: KnownDoc = { slug: created.slug, type, title }
    useDocsStore.setState((s) => ({ knownDocs: [...s.knownDocs, meta] }))
    return created.slug
  } catch (err) {
    console.error(`[wiki] ensureSeedDoc(${type}) failed`, err)
    return null
  }
}

/** Create a user-defined wiki page with the given display name.
 * Type is `wiki:custom-<id>` — the random suffix avoids collisions
 * if the user picks the same name twice and decouples the type
 * (immutable identity) from the title (renameable label).
 *
 * Returns the new doc's slug, or null on failure (empty name or
 * proof-server error). The created doc is registered in the catalog
 * but NOT auto-opened — the caller decides whether to navigate. */
export async function createCustomWikiPage(
  name: string,
): Promise<string | null> {
  const trimmed = name.trim()
  if (!trimmed) return null
  // 8 hex chars = 32 bits. Collision probability is negligible at the
  // scale of one user's wiki — even a thousand pages stays well below
  // the birthday-collision threshold.
  const id = Math.random().toString(36).slice(2, 10)
  const type = `wiki:custom-${id}` as `wiki:${string}`
  try {
    const created = await proofClient.createDoc(trimmed, '​')
    const meta: KnownDoc = { slug: created.slug, type, title: trimmed }
    useDocsStore.setState((s) => ({ knownDocs: [...s.knownDocs, meta] }))
    return created.slug
  } catch (err) {
    console.error('[wiki] createCustomWikiPage failed', err)
    return null
  }
}

/** Slug of the (seed) wiki doc with the given type, if any. */
export function getWikiSlug(type: SeedType): string | null {
  const doc = useDocsStore.getState().knownDocs.find((d) => d.type === type)
  return doc?.slug ?? null
}

/** Backwards-compatible accessor used by older callers; prefer
 * getWikiSlug('wiki:belief') in new code. */
export function getBeliefSlug(): string | null {
  return getWikiSlug('wiki:belief')
}

/** Fetch the markdown body of a wiki doc by slug. Returns '' when the
 * doc is empty (or just the ZWS placeholder), the slug is unknown,
 * or the proof-server is unreachable.
 *
 * Endpoint is `GET /documents/:slug` (canonical doc resource served
 * by proof-sdk's apiRoutes). Response body has `markdown: string`.
 * The bridge sub-route `/documents/:slug/state` is metadata-only and
 * intentionally does NOT include markdown. */
async function readWikiMarkdown(slug: string | null): Promise<string> {
  if (!slug) return ''
  try {
    const res = await fetch(
      `${PROOF_BASE_URL}/documents/${encodeURIComponent(slug)}`,
    )
    if (!res.ok) return ''
    const json = (await res.json()) as { markdown?: string }
    const md = (json.markdown ?? '').trim()
    // ZWS-only or whitespace-only counts as empty — we don't want a
    // stray invisible char polluting the cacheable prefix.
    if (!md || md.replace(/[​\s]/g, '') === '') return ''
    return md
  } catch (err) {
    console.warn('[wiki] readWikiMarkdown failed', slug, err)
    return ''
  }
}

/** Backwards-compatible accessor for belief alone. */
export async function readBeliefMarkdown(): Promise<string> {
  return readWikiMarkdown(getBeliefSlug())
}

/** Read every wiki:* page in the catalog and return a single
 * cacheable context block, already shaped for the chat system
 * prompt. Each non-empty section is wrapped with a heading; empty
 * sections are skipped entirely so the prefix stays compact.
 * Returns '' when no wiki content exists yet — chat assembly takes
 * the empty path in that case.
 *
 * Order is stable and tuned for Anthropic prompt-cache hits:
 *   1. Regular seeds in WIKI_SEEDS order (lowest-churn identity)
 *   2. Custom user pages in catalog order
 *   3. pinToEnd seeds last (highest-churn — log.md changes most often)
 * Putting the timeline at the bottom means a log append only
 * invalidates its own section, not the cached identity above it. */
export async function readWikiContext(): Promise<string> {
  const docs = useDocsStore
    .getState()
    .knownDocs.filter((d) => d.type.startsWith('wiki:') && !d.archivedAt)

  const seedTypes = WIKI_SEEDS.map((s) => s.type) as readonly string[]
  const seedsHead = WIKI_SEEDS.filter((s) => !('pinToEnd' in s && s.pinToEnd))
  const seedsTail = WIKI_SEEDS.filter((s) => 'pinToEnd' in s && s.pinToEnd)

  const head = seedsHead.flatMap((def) => {
    const d = docs.find((doc) => doc.type === def.type)
    return d ? [{ doc: d, def }] : []
  })
  const customs = docs
    .filter((d) => !seedTypes.includes(d.type))
    .map((d) => ({ doc: d, def: undefined as undefined }))
  const tail = seedsTail.flatMap((def) => {
    const d = docs.find((doc) => doc.type === def.type)
    return d ? [{ doc: d, def }] : []
  })

  const sections = await Promise.all(
    [...head, ...customs, ...tail].map(async ({ doc, def }) => {
      const md = await readWikiMarkdown(doc.slug)
      if (!md) return ''
      const heading = def?.heading ?? headingFor(doc)
      const tailLines =
        def && 'tailLines' in def ? def.tailLines : undefined
      const body = tailLines ? takeLastLines(md, tailLines) : md
      // Shape hint tells the ingest LLM which convention to follow when
      // proposing additions — entity pages get `### Name` blocks, list
      // pages stay flat bullets, timelines get `## [date]` lines, etc.
      // Detected from the live body so the page can drift over time
      // and the next ingest adapts automatically.
      const shape = detectShape(body)
      return `[USER ${heading} — ${shape}]\n${body}`
    }),
  )
  return sections.filter(Boolean).join('\n\n')
}

/** Keep only the last N non-empty lines of a markdown body. Used by
 * sections like the timeline log whose body grows unbounded — older
 * entries fall off the prompt rather than ballooning each turn's
 * input. Empty/whitespace lines are excluded from the count so a
 * gap in the file doesn't shift real content out of view. */
function takeLastLines(md: string, n: number): string {
  const lines = md.split('\n')
  const kept: string[] = []
  let count = 0
  for (let i = lines.length - 1; i >= 0 && count < n; i -= 1) {
    kept.unshift(lines[i])
    if (lines[i].trim().length > 0) count += 1
  }
  return kept.join('\n')
}

/** Heading used in the chat system prompt for a custom wiki page.
 * Uses the user-set title uppercased, falling back to a generic
 * label so an unnamed page still parses cleanly. Stripping non-
 * alphanumerics keeps the heading visually consistent with seed
 * headings (BELIEFS / ENTITIES / EPISODES). */
function headingFor(doc: KnownDoc): string {
  const raw = (doc.title ?? '').trim()
  if (!raw) return 'WIKI'
  return raw.toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').trim() || 'WIKI'
}
