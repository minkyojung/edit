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

/** User-editable conventions page. Karpathy's CLAUDE.md pattern:
 * the rules for how the wiki is organized live in the wiki itself,
 * the user co-evolves them, and ingest prepends the page body to
 * its system prompt every call. We special-case it the same way as
 * `wiki:log` — known type id + lazy created on first need + filtered
 * out of the regular catalog snapshot (it's an instruction
 * surface, not a content surface). */
const CONVENTIONS_TYPE = 'wiki:conventions' as const

/** Default body seeded into the conventions page on first creation.
 * The user is expected to edit this freely — that's the whole
 * point. We pick a minimal starting set so the LLM has *some*
 * guidance even before the user customizes anything. */
const DEFAULT_CONVENTIONS = `## Conventions

These are the rules I follow when adding to my wiki. Edit this page to teach the LLM how my wiki should grow.

### Page shapes

- **entity** — pages of distinct subjects (people, orgs, tools). Use \`### Name\` headings with bullets underneath. New subject → write the full block. Existing subject → bullet only.
- **list** — flat bullets, no \`###\` headings. One bullet per item.
- **timeline** — append-only date log. Lines look like \`## [YYYY-MM-DD] kind | short summary\`.
- **prose** — free-form paragraphs.

### How to decide

- Look at each page's existing body. Match its shape. Don't introduce a new shape mid-page.
- If a fact doesn't clearly belong on any existing page, emit \`suggestNewPage: "PageName"\` instead of \`target\`. Pick a short, descriptive name. The system will create that page and stamp the content there as a mark for me to review.
- Only fall back to leaving \`proposals\` empty (with a \`logEntry\` note) if you genuinely can't tell what the content is about — \`suggestNewPage\` is preferred over silence.
- Skip transient stuff (mood, weather, small talk). Only durable info belongs in the wiki.
`

/** Ensure the wiki:log doc exists. Lazy: created on first call.
 * Returns the slug, or null if proof-server is unreachable. The
 * timeline is one of two "system-owned" wiki pages (the other is
 * conventions); everything else is user-created. */
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

/** Ensure the wiki:conventions doc exists, seeded with default
 * rules on first creation. Lazy: called from runIngest right
 * before the LLM call. Returns the slug, or null on failure (in
 * which case ingest falls back to the static system prompt only). */
export async function ensureConventionsWikiSlug(): Promise<string | null> {
  const existing = useDocsStore
    .getState()
    .knownDocs.find((d) => d.type === CONVENTIONS_TYPE && !d.archivedAt)
  if (existing) return existing.slug
  try {
    const created = await proofClient.createDoc('Conventions', DEFAULT_CONVENTIONS)
    const meta: KnownDoc = {
      slug: created.slug,
      type: CONVENTIONS_TYPE,
      title: 'Conventions',
    }
    useDocsStore.setState((s) => ({ knownDocs: [...s.knownDocs, meta] }))
    return created.slug
  } catch (err) {
    console.error('[wiki] ensureConventionsWikiSlug failed', err)
    return null
  }
}

/** Read the user's conventions page body. Returns '' when the page
 * doesn't exist or fetch fails — caller should treat that as "use
 * the static fallback rules in the system prompt". */
export async function readConventions(): Promise<string> {
  const doc = useDocsStore
    .getState()
    .knownDocs.find((d) => d.type === CONVENTIONS_TYPE && !d.archivedAt)
  if (!doc) return ''
  return readWikiMarkdown(doc.slug)
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
 * `body` is the initial markdown content. Default is a ZWS so the
 * server's blank-body guard accepts the doc; callers that already
 * know what should live on the page (the ingest layer materializing
 * a `suggestNewPage` proposal) pass real markdown so the page is
 * "born" with content. Seeding via `body` here, instead of stamping
 * the content as a mark afterwards, keeps the create path and the
 * inline-review path on disjoint surfaces — the mark system never
 * has to deal with empty-page placeholder scaffolding.
 *
 * Returns the new doc's slug, or null on failure (empty name or
 * proof-server error). The created doc is registered in the catalog
 * but NOT auto-opened — the caller decides whether to navigate. */
export async function createCustomWikiPage(
  name: string,
  body?: string,
): Promise<string | null> {
  const trimmed = name.trim()
  if (!trimmed) return null
  // 8 hex chars = 32 bits. Collision probability is negligible at the
  // scale of one user's wiki — even a thousand pages stays well below
  // the birthday-collision threshold.
  const id = Math.random().toString(36).slice(2, 10)
  const type = `wiki:custom-${id}` as `wiki:${string}`
  const initialBody = body && body.trim().length > 0 ? body : '​'
  try {
    const created = await proofClient.createDoc(trimmed, initialBody)
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

/** Read every wiki:* page in the catalog and return one cacheable
 * context block: each page becomes a `[type — title — shape]` block
 * followed by its body. Empty pages emit `(empty)` so the LLM knows
 * the page exists but has no content to anchor on yet — important
 * for routing decisions ("does this fact belong here? the page is
 * empty, so the only signal is the title").
 *
 * The block header carries the wiki page's `type` id directly, so
 * the LLM has one place to read both "what targets exist" and
 * "what's already in each". This used to be split across an
 * AVAILABLE-PAGES list and a separate body snapshot; merging them
 * removes a label-vs-id matching step the model had to do
 * implicitly.
 *
 * Order: catalog order, with `wiki:log` (the agent's append-only
 * timeline) pinned to the very end. Putting the timeline last means
 * a log append only invalidates its own section in the prompt
 * cache, not the more-stable identity sections above it. The log
 * body is also tail-truncated since it grows unbounded. */
export async function readWikiContext(): Promise<string> {
  const docs = useDocsStore
    .getState()
    .knownDocs.filter(
      (d) =>
        d.type.startsWith('wiki:') &&
        !d.archivedAt &&
        // The conventions page is fed to the LLM separately as
        // system-prompt context, not as a target the LLM can route
        // proposals to. Excluding it here keeps the catalog clean.
        d.type !== CONVENTIONS_TYPE,
    )

  const head = docs.filter((d) => d.type !== LOG_TYPE)
  const tail = docs.filter((d) => d.type === LOG_TYPE)

  const sections = await Promise.all(
    [...head, ...tail].map(async (doc) => {
      const md = await readWikiMarkdown(doc.slug)
      const title = (doc.title ?? '').trim() || doc.type.replace(/^wiki:/, '')
      if (!md) {
        // Empty pages still appear in the catalog so the LLM can
        // route to them by name — but we mark them empty rather
        // than hallucinating content.
        return `[${doc.type} — ${title}]\n(empty)`
      }
      const body = doc.type === LOG_TYPE ? takeLastLines(md, LOG_TAIL_LINES) : md
      // No shape label — the LLM reads the body and infers the
      // page's pattern itself, guided by the user's conventions
      // page. Karpathy: "the model sees what you see; it doesn't
      // need your enum."
      return `[${doc.type} — ${title}]\n${body}`
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

