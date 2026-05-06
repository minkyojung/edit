// Wiki bootstrap — Karpathy LLM Wiki structure on top of proof-sdk.
//
// v1 scope: three wiki pages — belief / entity / episode — that
// capture the user's preferences, the people / orgs / concepts they
// reference, and the events worth remembering. The chat runner reads
// all three before each turn and prepends them as the cacheable
// prefix of the system prompt so Claude can answer with the user's
// context loaded.
//
// Future (P3 / Memory-writer) will let a background agent edit these
// pages with provenance. For now, the user edits them by hand from
// the sidebar Wiki section.

import { proofClient } from '@/lib/proofClient'
import { useDocsStore, type KnownDoc } from './docsStore'

const PROOF_BASE_URL = 'http://localhost:4000'

/** Wiki types we bootstrap on first launch and keep in sync with the
 * sidebar. Order is meaningful — it's the order in which sections
 * appear in the chat system prompt and (today) in the sidebar list. */
const WIKI_TYPES = [
  { type: 'wiki:belief', title: 'belief', heading: 'BELIEFS' },
  { type: 'wiki:entity', title: 'entity', heading: 'ENTITIES' },
  { type: 'wiki:episode', title: 'episode', heading: 'EPISODES' },
] as const

type WikiType = (typeof WIKI_TYPES)[number]['type']

/** Ensure each wiki type has a doc in the catalog. Idempotent.
 * Called from docsStore.bootstrap as fire-and-forget — chat reads
 * wiki content lazily so the first paint isn't blocked on these
 * round-trips. */
export async function ensureWikiDocs(): Promise<void> {
  for (const def of WIKI_TYPES) {
    await ensureWikiDoc(def.type, def.title).catch((err) =>
      console.error(`[wiki] ensure ${def.type} failed`, err),
    )
  }
}

async function ensureWikiDoc(
  type: WikiType,
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
    console.error(`[wiki] ensureWikiDoc(${type}) failed`, err)
    return null
  }
}

/** Slug of the wiki doc with the given type, if any. Synchronous —
 * pulls from the catalog mirror. */
export function getWikiSlug(type: WikiType): string | null {
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

/** Read all wiki pages and return a single cacheable context block,
 * already shaped for the chat system prompt. Each non-empty section
 * is wrapped with a heading; empty sections are skipped entirely so
 * the prefix stays compact. Returns '' when no wiki content exists
 * yet — chat assembly takes the empty-belief path in that case.
 *
 * Sections appear in WIKI_TYPES order so the cache prefix is stable
 * across runs (rearranging would invalidate prompt cache hits). */
export async function readWikiContext(): Promise<string> {
  const sections = await Promise.all(
    WIKI_TYPES.map(async (def) => {
      const md = await readWikiMarkdown(getWikiSlug(def.type))
      return md ? `[USER ${def.heading}]\n${md}` : ''
    }),
  )
  return sections.filter(Boolean).join('\n\n')
}
