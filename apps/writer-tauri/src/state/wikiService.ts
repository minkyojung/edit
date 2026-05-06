// Wiki bootstrap — Karpathy LLM Wiki structure on top of proof-sdk.
//
// v1 scope: a single belief doc that captures the user's preferences /
// style / recurring opinions. The chat runner prepends its body to
// every system prompt so Claude can answer in the user's voice rather
// than as a generic assistant.
//
// Future (P3 / Memory-writer) will add entity + episode pages and let
// a background agent edit them with provenance. For now, the user
// edits belief by hand from the sidebar Wiki section.

import { proofClient } from '@/lib/proofClient'
import { useDocsStore, type KnownDoc } from './docsStore'

const BELIEF_TYPE = 'wiki:belief' as const
const BELIEF_TITLE = 'belief'
const PROOF_BASE_URL = 'http://localhost:4000'

/** Ensure a single wiki:belief doc exists in the catalog. Idempotent.
 * Called from docsStore.bootstrap as fire-and-forget — chat reads
 * belief lazily so the first paint isn't blocked on this round-trip. */
export async function ensureBeliefDoc(): Promise<string | null> {
  const existing = useDocsStore
    .getState()
    .knownDocs.find((d) => d.type === BELIEF_TYPE)
  if (existing) return existing.slug
  try {
    // ZWS body so the proof-server's blank-markdown guard accepts it.
    // The user's belief grows from here — empty until they write.
    const created = await proofClient.createDoc(BELIEF_TITLE, '​')
    const meta: KnownDoc = {
      slug: created.slug,
      type: BELIEF_TYPE,
      title: BELIEF_TITLE,
    }
    useDocsStore.setState((s) => ({ knownDocs: [...s.knownDocs, meta] }))
    return created.slug
  } catch (err) {
    console.error('[wiki] ensureBeliefDoc failed', err)
    return null
  }
}

/** Slug of the current belief doc, if any. Synchronous — pulls from
 * the catalog mirror. Returns null before bootstrap finishes or if
 * ensureBeliefDoc hasn't run. */
export function getBeliefSlug(): string | null {
  const doc = useDocsStore
    .getState()
    .knownDocs.find((d) => d.type === BELIEF_TYPE)
  return doc?.slug ?? null
}

/** Fetch the belief markdown body. Returns empty string when no belief
 * doc exists yet, the body is just the ZWS placeholder, or the
 * proof-server is unreachable. The chat runner uses this to populate
 * the cacheable prefix of the system prompt — empty result means
 * "no belief context", which the prompt assembly handles cleanly.
 *
 * Endpoint is `GET /documents/:slug` (canonical doc resource, served
 * by proof-sdk's apiRoutes — both `/api/documents/:slug` and the
 * un-prefixed `/documents/:slug` are mounted to the same handler).
 * The response body has `markdown: string`. The bridge sub-route
 * `/documents/:slug/state` is a metadata-only revision/updatedAt
 * probe and intentionally does NOT include markdown. */
export async function readBeliefMarkdown(): Promise<string> {
  const slug = getBeliefSlug()
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
    console.warn('[wiki] readBeliefMarkdown failed', err)
    return ''
  }
}
