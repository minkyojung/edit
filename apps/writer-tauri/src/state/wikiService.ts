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
import { generateClientSlug } from '@/lib/slug'
import { isEffectivelyEmpty } from '@/lib/markdownText'
import {
  useDocsStore,
  isUserOwnedWiki,
  type KnownDoc,
} from './docsStore'

const PROOF_BASE_URL = 'http://localhost:4000'

/** The agent's append-only timeline. Held in a constant so the
 * lazy-create path (`ensureLogWikiSlug`) and the read path
 * (`readWikiContext`) agree on the type id. `system:*` prefix
 * marks this as agent meta surface — see KnownDoc.type doc. */
const LOG_TYPE = 'system:log' as const
/** Cap the log body to the last N non-empty lines when it gets fed
 * to the LLM. The timeline grows unbounded otherwise and would
 * slowly bloat every prompt. */
const LOG_TAIL_LINES = 30

/** User-editable conventions page. Karpathy's CLAUDE.md pattern:
 * the rules for how the wiki is organized live in the wiki itself,
 * the user co-evolves them, and ingest prepends the page body to
 * its system prompt every call. `system:*` prefix groups it with
 * the other agent meta surfaces (log, index) so sidebar branching
 * and catalog filtering use a single predicate. */
const CONVENTIONS_TYPE = 'system:conventions' as const

/** System-owned summary index of every wiki page. Karpathy's
 * `index.md` pattern — one line per page, lets the ingest LLM see
 * "what targets exist" without having to dump every body into the
 * prompt. Lazy created on first ingest pass. `system:*` prefix
 * groups it with the other agent meta surfaces — the LLM never
 * routes a proposal to it, the catalog filter excludes it, the
 * sidebar's System group renders it separately from user wiki
 * pages. Index is system-managed metadata, not a content target. */
const INDEX_TYPE = 'system:index' as const

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

### Length

- Keep each proposal's content concise — one bullet line or a short block of two or three lines, not a wall of text. If a fact deserves more than a few lines, split it into multiple proposals or summarize aggressively. I can always re-ingest later for missing detail.

### Categories

I organize my wiki by creating top-level pages that act as categories — for me these are e.g. \`Work\`, \`People\`, \`Study\`, but pick whatever shows up as a top-level page in my actual WIKI block.

When you create a new page via \`suggestNewPage\`, also pick the most fitting existing top-level page as its parent and emit its type id (the part before the em-dash in the WIKI block header — e.g. \`wiki:custom-7nt...\`) as \`suggestNewPageParent\`. Copy the id verbatim from the header; never use the title and never invent an id. If nothing fits, leave \`suggestNewPageParent\` null and the page is created at the root for me to file later.

A page that already has children naturally acts as a category. Don't create a category page yourself unless I clearly need one and I haven't made it — propose with \`suggestNewPage\` and a short name like "Books", and I'll review.
`

/** Lazy-create shape for an agent-managed `system:*` page. Each one
 * carries the same three differences (type id, display title,
 * initial body) and otherwise follows the identical setup: probe
 * the catalog, mint a client slug if missing, register the doc
 * locally, fire-and-forget the server create. Pulling the config
 * out into a record keeps the per-page ensure* helpers below to
 * one line each and makes adding a new system page (Phase 4 lint,
 * Phase 5 about, etc.) a single config edit. */
interface SystemPageConfig {
  type: KnownDoc['type']
  title: string
  initialBody: string
}

const SYSTEM_PAGE_LOG: SystemPageConfig = {
  type: LOG_TYPE,
  title: 'log',
  initialBody: '',
}
const SYSTEM_PAGE_CONVENTIONS: SystemPageConfig = {
  type: CONVENTIONS_TYPE,
  title: 'Conventions',
  initialBody: DEFAULT_CONVENTIONS,
}
const SYSTEM_PAGE_INDEX: SystemPageConfig = {
  type: INDEX_TYPE,
  title: 'index',
  initialBody: '',
}

/** Shared body for the three lazy-create helpers below. Probes the
 * catalog, then on first-need mints a client-side slug so the page
 * exists locally even when proof-server is unreachable. The server
 * register call is fire-and-forget — failures leave the page local
 * until the next online boot. Empty body is the post-relaxation
 * default for system pages (ZWS placeholder caused the placeholder-
 * hint regression in commit 046a0701). */
async function ensureSystemPage(
  config: SystemPageConfig,
): Promise<string | null> {
  const existing = useDocsStore
    .getState()
    .knownDocs.find((d) => d.type === config.type && !d.archivedAt)
  if (existing) return existing.slug
  const slug = generateClientSlug()
  const meta: KnownDoc = { slug, type: config.type, title: config.title }
  useDocsStore.setState((s) => ({ knownDocs: [...s.knownDocs, meta] }))
  void proofClient
    .createDoc(config.title, config.initialBody, { slug })
    .catch((err) => {
      console.warn(
        `[wiki] ensureSystemPage(${config.type}) background register failed`,
        err,
      )
    })
  return slug
}

/** Ensure `system:log` exists. The agent's append-only timeline —
 * created lazily on the first ingest pass that produces a log
 * entry. */
export async function ensureLogWikiSlug(): Promise<string | null> {
  return ensureSystemPage(SYSTEM_PAGE_LOG)
}

/** Ensure `system:conventions` exists, seeded with DEFAULT_CONVENTIONS
 * on first creation. Called from runIngest right before the LLM
 * call so the user can edit the conventions and have them shadow
 * the static rules on the very next pass. */
export async function ensureConventionsWikiSlug(): Promise<string | null> {
  return ensureSystemPage(SYSTEM_PAGE_CONVENTIONS)
}

/** Ensure `system:index` exists. Body stays empty on create; real
 * summary lines arrive as `indexUpdates` merge into the page body
 * on first navigation. */
export async function ensureIndexWikiSlug(): Promise<string | null> {
  return ensureSystemPage(SYSTEM_PAGE_INDEX)
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

/** Read the wiki:index body as a labeled INDEX block for the
 * ingest prompt. The LLM sees what summaries already exist so it
 * can decide whether to emit a new `indexUpdates` entry or leave a
 * page's line untouched. Returns '' when the page is missing or
 * empty so callers can skip the block entirely. */
export async function readIndexContext(): Promise<string> {
  const doc = useDocsStore
    .getState()
    .knownDocs.find((d) => d.type === INDEX_TYPE && !d.archivedAt)
  if (!doc) return ''
  const md = await readWikiMarkdown(doc.slug)
  if (!md) return ''
  return md
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
 * `options.parentId` nests the new page under an existing wiki:
 * custom-* doc. Used by the in-row `+` affordance ("create child
 * page") and by ingest's auto-categorization (Phase 2). The parent
 * must exist, be live (not archived), and itself be a wiki:custom-*
 * page — system:* pages refuse children since they're agent meta
 * surfaces, not content categories. Invalid parent is treated as
 * a programmer error and dropped (page still created at root) so
 * callers don't accidentally lose a write because of a stale slug.
 *
 * Returns the new doc's slug, or null on failure (proof-server
 * error). The created doc is registered in the catalog but NOT
 * auto-opened — the caller decides whether to navigate. */
export async function createCustomWikiPage(
  name: string,
  body?: string,
  options?: { parentId?: string },
): Promise<string | null> {
  const trimmed = name.trim()
  // 8 hex chars = 32 bits. Collision probability is negligible at the
  // scale of one user's wiki — even a thousand pages stays well below
  // the birthday-collision threshold.
  const id = Math.random().toString(36).slice(2, 10)
  const type = `wiki:custom-${id}` as `wiki:${string}`
  // Empty body when no real content is given. proof-server accepts
  // blank bodies; sending a ZWS placeholder here (the legacy guard
  // workaround) gave fresh wiki pages an invisible-char paragraph
  // that placeholderPlugin's hint check sometimes missed — same
  // path as daily / writing creation now.
  const initialBody = body && body.trim().length > 0 ? body : ''
  const slug = generateClientSlug()

  // Validate parentId before writing the catalog entry. A bad
  // parent quietly degrades to root creation — we still want the
  // page to exist so the caller's write isn't lost.
  let parentId: string | undefined
  if (options?.parentId) {
    const parent = useDocsStore
      .getState()
      .knownDocs.find((d) => d.slug === options.parentId)
    const valid = parent && !parent.archivedAt && isUserOwnedWiki(parent)
    if (valid) {
      parentId = parent.slug
    } else {
      console.warn(
        '[wiki] createCustomWikiPage: invalid parentId, creating at root',
        options.parentId,
      )
    }
  }

  // Empty title is stored as undefined rather than '' so the catalog
  // entry omits the key entirely; useDocLabel falls back to 'Untitled'
  // when both the live body label and the cached title are empty.
  const baseMeta: KnownDoc = trimmed
    ? { slug, type, title: trimmed }
    : { slug, type }
  const meta: KnownDoc = parentId ? { ...baseMeta, parentId } : baseMeta
  useDocsStore.setState((s) => ({ knownDocs: [...s.knownDocs, meta] }))
  void proofClient.createDoc(trimmed, initialBody, { slug }).catch((err) => {
    console.warn('[wiki] createCustomWikiPage background register failed', err)
  })
  return slug
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
    // Treat zero-width / whitespace-only bodies as empty — shared
    // isEffectivelyEmpty covers the variants the server occasionally
    // produces. Without this, a stray invisible char would pollute
    // the cacheable system-prompt prefix.
    if (isEffectivelyEmpty(md)) return ''
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
        !d.archivedAt &&
        // Content pages — every `wiki:custom-*` user wiki page is a
        // valid routing target. system:conventions / system:index
        // arrive on dedicated prompt channels (system-prompt prefix
        // + INDEX block respectively), so they stay out of this
        // catalog. system:log is the one system page that does sit
        // inside the catalog block — its rolling timeline is part
        // of the wiki's read context and the head/tail split below
        // pins it to the end so a log append only invalidates its
        // own cache section.
        (d.type.startsWith('wiki:') || d.type === LOG_TYPE),
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

