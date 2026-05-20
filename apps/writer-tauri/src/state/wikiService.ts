// Wiki bootstrap — Karpathy "wiki grows from use" structure.
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

import { generateClientSlug } from '@/lib/slug'
import { isEffectivelyEmpty } from '@/lib/markdownText'
import {
  useDocsStore,
  type KnownDoc,
} from './docsStore'
import { useEditorViewStore } from './editorViewStore'

// PROOF_BASE_URL removed (Phase 3.A.2). All wiki body reads go
// through the local Y.Doc + Milkdown serializer now.

/** The agent's append-only timeline. `system:*` prefix marks this
 * as agent meta surface — see KnownDoc.type doc. */
const LOG_TYPE = 'system:log' as const

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

This wiki is my external memory. The LLM reads my daily notes and keeps the wiki up to date. Edit this page to teach the LLM how my wiki should grow.

### One page per entity

Each distinct subject is ONE page. The page's name IS the entity's name:

- a person  → page named after that person  ("Sarah", "Tom")
- a book    → page named after the title    ("The Pragmatic Programmer")
- a project → page named after it           ("Project X")
- a concept → page named after it           ("Distributed Systems")

The page's body is a flat list of facts about that subject — one bullet per fact, plain prose, no nested headings.

### Adding new info

When ingesting a daily note:

- The fact is about an existing page (look at the WIKI block headers) → emit \`target: <type-id>\` with the bullets to append. Copy the type id verbatim from \`[<type-id> — <title>]\`.
- The fact is about a NEW subject not in the WIKI → emit \`suggestNewPage: "<entity name>"\`. The entity name goes here, NOT a category ("Sarah", not "People").
- The fact is transient (mood, weather, small talk) → skip it. Only durable info belongs in the wiki.

Never invent type ids; copy them verbatim.

### Linking

When a bullet mentions another page that already exists in the WIKI block, wrap that page's title with double-brackets so it renders as a clickable link: \`Working with [[Sarah]] on the project\`. Use the title exactly as it appears in the block header. Skip the link when no existing page matches the mention — don't invent links. Never self-link (don't link \`entity\` from inside its own page).

### Length

Each proposal's content is concise — one bullet or a short block of two or three lines. If a fact deserves more, split it into multiple proposals. The wiki accumulates; over-stuffing one bullet ages worse than splitting.
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
// wiki:profile uses the SAME lazy-create helper despite the `wiki:`
// prefix instead of `system:` — the only thing the helper cares
// about is the type id + initial body. Profile body is populated
// by extractProfile after URL ingest, so initial body stays empty;
// users opening the page before bootstrap completes see a blank
// editable doc, same as a freshly-minted custom wiki page.
const SYSTEM_PAGE_PROFILE: SystemPageConfig = {
  type: 'wiki:profile',
  title: 'Profile',
  initialBody: '',
}

/** Shared body for the three lazy-create helpers below. Probes the
 * catalog, then on first-need mints a client-side slug. Empty body
 * is the default for system pages (a ZWS placeholder caused the
 * placeholder-hint regression in commit 046a0701). */
async function ensureSystemPage(
  config: SystemPageConfig,
): Promise<string | null> {
  const existing = useDocsStore
    .getState()
    .knownDocs.find((d) => d.type === config.type && !d.archivedAt)
  if (existing) {
    // Legacy fix-up: a page created during the Phase 3.B window
    // (before this transaction-style seed) is still blank in its
    // Y.Doc. seedDocBody is a no-op when the body already has
    // content (deriveLabel check inside), so this is safe and
    // recovers the seed on next ingest pass.
    if (config.initialBody) {
      try {
        await useDocsStore.getState().seedDocBody(existing.slug, config.initialBody)
      } catch (err) {
        console.warn(
          `[wiki] ensureSystemPage(${config.type}) re-seed failed`,
          err,
        )
      }
    }
    return existing.slug
  }
  const slug = generateClientSlug()
  const meta: KnownDoc = { slug, type: config.type, title: config.title }
  useDocsStore.setState((s) => ({ knownDocs: [...s.knownDocs, meta] }))
  // Seed body as part of the create transaction — function does
  // not return until the Y.Doc has the initial content and IDB
  // has persisted. The previous fire-and-forget pattern produced
  // race conditions where the LLM read an empty conventions page
  // depending on which doc was active when ingest ran.
  if (config.initialBody) {
    try {
      await useDocsStore.getState().seedDocBody(slug, config.initialBody)
    } catch (err) {
      console.warn(
        `[wiki] ensureSystemPage(${config.type}) seed failed`,
        err,
      )
    }
  }
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

/** Ensure `system:index` exists. The page body is system-owned —
 * see state/wikiIndex.ts which writes a deterministic catalog on
 * every wiki change. Body stays empty until the first persist tick
 * lands; user edits to the page are tolerated but transient (next
 * invalidation overwrites them). */
export async function ensureIndexWikiSlug(): Promise<string | null> {
  return ensureSystemPage(SYSTEM_PAGE_INDEX)
}

/** Ensure `wiki:profile` exists. The user's self-profile page —
 * created either by `extractProfile` (URL → LLM → markdown body)
 * during BootstrapDialog Stage 2, or lazily on first need if the
 * user skipped bootstrap. Body is empty until extractProfile (or
 * direct user editing) fills it. */
export async function ensureProfileWikiSlug(): Promise<string | null> {
  return ensureSystemPage(SYSTEM_PAGE_PROFILE)
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
 * `body` is the initial markdown content. Empty by default; callers
 * that already know what should live on the page (the ingest layer
 * materializing a `suggestNewPage` proposal) pass real markdown.
 * Seeding via `body` (rather than stamping marks afterwards) keeps
 * the create path and the review path on disjoint surfaces.
 *
 * Wiki pages are flat — there is no parent / category nesting.
 * Sidebar groups them with the wiki:custom-* type prefix; entity
 * pages (Sarah, The Pragmatic Programmer, Project X) live side by
 * side. The previous parent option was removed when ingest's
 * `suggestNewPageParent` flow was dropped.
 *
 * Returns the new doc's slug, or null on failure. The created doc
 * is registered in the catalog but NOT auto-opened — the caller
 * decides whether to navigate. */
export async function createCustomWikiPage(
  name: string,
  body?: string,
): Promise<string | null> {
  const trimmed = name.trim()
  // 8 hex chars = 32 bits. Collision probability is negligible at the
  // scale of one user's wiki — even a thousand pages stays well below
  // the birthday-collision threshold.
  const id = Math.random().toString(36).slice(2, 10)
  const type = `wiki:custom-${id}` as `wiki:${string}`
  const initialBody = body && body.trim().length > 0 ? body : ''
  const slug = generateClientSlug()

  // Empty title is stored as undefined rather than '' so the catalog
  // entry omits the key entirely; useDocLabel falls back to 'Untitled'
  // when both the live body label and the cached title are empty.
  const meta: KnownDoc = trimmed
    ? { slug, type, title: trimmed }
    : { slug, type }
  useDocsStore.setState((s) => ({ knownDocs: [...s.knownDocs, meta] }))
  // Seed body as part of the create transaction. Caller awaits
  // this function, so on return the page is fully ready: catalog
  // entry exists, Y.Doc has the body, IDB has persisted it. ingest
  // / banner accept / sidebar `+` all rely on that contract — no
  // "the page is here but empty for a beat" race.
  if (initialBody) {
    try {
      await useDocsStore.getState().seedDocBody(slug, initialBody)
      // Fire-and-forget: kick off an aiSummary generation for the
      // Tier 1 catalog. New pages start with the ingest-provided
      // body, so a summary here captures the page's initial nature
      // before the user has navigated to it. Failure (sidecar down,
      // network, etc.) leaves sidecar.aiSummary unset and the index
      // falls back to bodyExcerpt — no correctness impact.
      void (async () => {
        const { regenerateAiSummaryForSlug } = await import(
          '@/agent/generateAiSummary'
        )
        await regenerateAiSummaryForSlug(slug)
      })()
    } catch (err) {
      console.warn('[wiki] createCustomWikiPage seed failed', err)
    }
  }
  return slug
}

/** Read a wiki doc's markdown body from the client side.
 *
 * Strategy mirrors agent/ingest.ts:readDocMarkdown:
 *   - Active doc → Milkdown's serializer on view.state.doc
 *     (full markdown round-trip).
 *   - Non-active doc → Y.XmlFragment.toString() fallback (loses
 *     markdown structure but preserves text — fine for the LLM,
 *     which only reads it to understand "what exists on this
 *     page" for routing decisions).
 *
 * Returns '' for missing handles, empty bodies, or anything that
 * the shared isEffectivelyEmpty predicate considers blank. */
export function readWikiMarkdown(slug: string | null): string {
  if (!slug) return ''

  const docs = useDocsStore.getState()
  const handle = docs.handles[slug]
  if (!handle) return ''

  if (docs.activeSlug === slug) {
    const view = useEditorViewStore.getState().view
    const serializer = useEditorViewStore.getState().serializer
    if (view && serializer) {
      try {
        const md = serializer(view.state.doc).trim()
        if (isEffectivelyEmpty(md)) return ''
        return md
      } catch {
        // fall through to fragment fallback
      }
    }
  }

  const fragment = handle.ydoc.getXmlFragment('prosemirror')
  const text = fragment.toString().trim()
  if (isEffectivelyEmpty(text)) return ''
  return text
}

