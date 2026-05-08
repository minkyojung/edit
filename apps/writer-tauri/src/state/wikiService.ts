// Wiki bootstrap — Karpathy "wiki grows from use" structure on top of
// proof-sdk.
//
// We do NOT pre-seed any wiki pages on first launch. Empty seed pages
// with abstract names (belief / entity / episode) just confused the
// LLM about where to route new info, and confused the user about
// what to put in them. The wiki starts empty; pages come into
// existence the moment they have something to put in them — either
// via the sidebar `+` button (createCustomWikiPage) or, in a later
// step, via the agent itself proposing "make a new page for X".
//
// `wiki:log` is the one exception: it's the agent's append-only
// timeline of ingest passes (one line per pass). It's lazily created
// the first time an ingest produces a logEntry — see
// `ensureLogWikiSlug` below.

import { proofClient } from '@/lib/proofClient'
import { detectShape } from '@/agent/wikiShape'
import { useDocsStore, type KnownDoc } from './docsStore'

const PROOF_BASE_URL = 'http://localhost:4000'

/** The agent's append-only timeline. Held in a constant so the
 * lazy-create path (`ensureLogWikiSlug`) and the read path
 * (`readWikiContext`) agree on the type id. */
const LOG_TYPE = 'wiki:log' as const
/** Cap the log body to the last N non-empty lines when it gets fed
 * to the LLM. The timeline grows unbounded otherwise and would
 * slowly bloat every prompt. */
const LOG_TAIL_LINES = 30

/** Ensure the wiki:log doc exists. Lazy: created on first call.
 * Returns the slug, or null if proof-server is unreachable. The
 * timeline is the only "system-owned" wiki page; everything else is
 * user-created. */
export async function ensureLogWikiSlug(): Promise<string | null> {
  const existing = useDocsStore
    .getState()
    .knownDocs.find((d) => d.type === LOG_TYPE && !d.archivedAt)
  if (existing) return existing.slug
  try {
    // ZWS body so the proof-server's blank-markdown guard accepts it.
    const created = await proofClient.createDoc('log', '​')
    const meta: KnownDoc = { slug: created.slug, type: LOG_TYPE, title: 'log' }
    useDocsStore.setState((s) => ({ knownDocs: [...s.knownDocs, meta] }))
    return created.slug
  } catch (err) {
    console.error('[wiki] ensureLogWikiSlug failed', err)
    return null
  }
}

/** No-op placeholder kept so the docsStore bootstrap call site
 * doesn't have to special-case the new lazy model. The wiki used to
 * pre-seed three pages here; now it stays empty until something
 * actually needs to live in it. */
export async function ensureWikiDocs(): Promise<void> {
  // Intentionally empty — see file header.
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

/** Read every wiki:* page in the catalog and return a single
 * cacheable context block, already shaped for the chat system
 * prompt. Each non-empty section is wrapped with a heading; empty
 * sections are skipped entirely so the prefix stays compact.
 * Returns '' when no wiki content exists yet — chat assembly takes
 * the empty path in that case.
 *
 * Order: catalog order, with `wiki:log` (the agent's append-only
 * timeline) pinned to the very end. Putting the timeline last means
 * a log append only invalidates its own section in the prompt
 * cache, not the more-stable identity sections above it. The log
 * body is also tail-truncated since it grows unbounded. */
export async function readWikiContext(): Promise<string> {
  const docs = useDocsStore
    .getState()
    .knownDocs.filter((d) => d.type.startsWith('wiki:') && !d.archivedAt)

  const head = docs.filter((d) => d.type !== LOG_TYPE)
  const tail = docs.filter((d) => d.type === LOG_TYPE)

  const sections = await Promise.all(
    [...head, ...tail].map(async (doc) => {
      const md = await readWikiMarkdown(doc.slug)
      if (!md) return ''
      const heading = headingFor(doc)
      const body = doc.type === LOG_TYPE ? takeLastLines(md, LOG_TAIL_LINES) : md
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
