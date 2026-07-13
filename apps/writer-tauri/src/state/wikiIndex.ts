// Tier 1 of the context engineering pipeline — a system-generated map
// of the WHOLE vault, grouped by folder, one row per note, kept fresh
// by the vault dirty/flush cycle. Written to `_system/index.md`.
//
// The map is the LLM's answer to "what exists, and where" — it Reads
// this one file to orient before Glob/Read-ing the specific notes a
// turn needs. So the folders the user actually has (including an
// imported `research/`, a `projects/`, whatever they made) ARE the
// index's sections: the map mirrors their structure rather than
// imposing one. An earlier version listed only `wiki/` pages in a flat
// table, which left every note outside the knowledge base invisible to
// the model; this version catalogs the vault entire.
//
// Design principle (second brain): the map guarantees the LLM knows a
// note EXISTS — a note is never dropped for length. Detail (the summary
// column) is what compresses under scale, never the note's row. Dated
// notes collapse into a single `daily/` section: their time axis is the
// timeline's job (`_system/timeline.md`), not the space map's, so we
// don't fragment the index into one section per day.
//
// The catalog comes straight from `knownDocs` + sidecars + body
// backlink counts — deterministic, free, always current. It replaces
// the prior ingest-edited page (the LLM used to re-author it every
// pass — expensive and drift-prone).
//
// Responsibilities:
//   1. countBacklinks — how many other pages link to each target
//      (the `Links` column).
//   2. folderOf / orderSections / renderVaultIndex — pure grouping +
//      rendering, unit-tested.
//   3. buildWikiIndex — assemble the full map string from live state.
//   4. getWikiIndex + invalidateWikiIndex — memory cache + debounced
//      disk persist so chat / ingest grab the map cheaply between
//      vault changes.

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
import { getDefaultNoteFolder } from './settingsStore'
import { useDocsStore } from './docsStore'

/** Vault-relative folder that holds synthesized knowledge-base pages.
 * The CLAUDE.md "This vault" section binds the knowledge-base ROLE to
 * this folder; the index uses it only to label + top-sort that
 * section. Hard-coded to the default binding for now — U11 turns it
 * into a user setting injected each turn, at which point this constant
 * becomes a `getKnowledgeBaseFolder()` read (same shape as
 * {@link getDefaultNoteFolder} for the capture folder below). */
const KNOWLEDGE_BASE_FOLDER = 'wiki'

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

// ── Pure grouping + rendering ─────────────────────────────────────
//
// Split out from buildWikiIndex so the "which section does a note go
// in / in what order / how does it render" contract is unit-testable
// without store state or disk I/O.

/** One note row in the vault index. `path` is the note's vault-
 * relative address — the LLM feeds it straight back into Read/Edit
 * (in the file-first model the PATH is the note's identity, so there's
 * no separate type-id column anymore). */
export interface IndexRow {
  path: string
  title: string
  summary: string
  links: number
}

/** A folder section: its vault-relative folder path (`''` = vault
 * root), an optional role label (knowledge base / capture), the note
 * rows inside it, and any non-note attachments (pdf/image/…) sitting
 * in the same folder. A section with no rows and no attachments is an
 * empty folder the user made — kept in the map because it encodes
 * intent (a routing target waiting to be filled). */
export interface IndexSection {
  folder: string
  role: 'knowledge base' | 'capture' | null
  rows: IndexRow[]
  attachments: string[]
}

/** Derive the index section key for a note's path.
 *
 * All `daily/**` notes collapse into one `daily` section — the dated
 * stream is the timeline's axis, not the space map's, so we don't
 * fragment the index into a section per calendar day. Every other note
 * keys on its containing folder; a root-level note (`CLAUDE.md`) keys
 * on `''`, rendered as the root section. */
export function folderOf(path: string): string {
  if (path === 'daily' || path.startsWith('daily/')) return 'daily'
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

/** Order the sections for display: knowledge base first (the folder
 * the LLM works in most), then the capture inbox, then every other
 * folder alphabetically, with the dated `daily` stream last (bulky,
 * low-priority for the space map). Ties inside the "other" band break
 * alphabetically. Pure + stable — same input yields the same order,
 * so the persisted file doesn't churn between rebuilds. */
export function orderSections(
  sections: IndexSection[],
  knowledgeFolder: string,
  captureFolder: string,
): IndexSection[] {
  const rank = (s: IndexSection): number => {
    if (s.folder === knowledgeFolder) return 0
    if (s.folder === captureFolder) return 1
    if (s.folder === 'daily') return 3
    return 2
  }
  return [...sections].sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    return a.folder.localeCompare(b.folder)
  })
}

/** Render ordered sections to the markdown body of `_system/index.md`.
 * Each section is a `## folder/` heading (with role label + note
 * count) over a `| Path | Title | Summary | Links |` table, followed by
 * an **Attachments** list for any non-note files, or an `_(empty
 * folder)_` marker when the folder holds neither. No row cap: the
 * map's contract is that the LLM can see every note EXISTS; only the
 * summary column compresses (see {@link SUMMARY_MAX_LEN}). */
export function renderVaultIndex(sections: IndexSection[]): string {
  if (sections.length === 0) return '_The vault has no notes yet._'
  const blocks: string[] = []
  for (const s of sections) {
    const label = s.folder === '' ? '/' : `${s.folder}/`
    const role = s.role ? ` — ${s.role}` : ''
    const parts: string[] = [`## ${escapeMdCell(label)}${role} (${s.rows.length})`]
    if (s.rows.length > 0) {
      parts.push(
        [
          '| Path | Title | Summary | Links |',
          '|------|-------|---------|-------|',
          ...s.rows.map(
            (r) =>
              `| ${escapeMdCell(r.path)} | ${escapeMdCell(r.title)} | ${escapeMdCell(r.summary)} | ${r.links} |`,
          ),
        ].join('\n'),
      )
    }
    if (s.attachments.length > 0) {
      parts.push(
        ['**Attachments**', ...s.attachments.map((p) => `- ${escapeMdCell(p)}`)].join(
          '\n',
        ),
      )
    }
    if (s.rows.length === 0 && s.attachments.length === 0) {
      parts.push('_(empty folder)_')
    }
    blocks.push(parts.join('\n\n'))
  }
  return blocks.join('\n\n')
}

/** Filename (title fallback) for a note whose `KnownDoc.title` is
 * empty — e.g. a `daily` doc, which carries a date rather than a
 * title. The path basename minus `.md`. */
function basenameNoExt(path: string): string {
  const name = path.split('/').pop() ?? path
  return name.replace(/\.md$/, '')
}

/** Assemble the whole-vault index — every non-archived note grouped by
 * folder, rendered as folder sections of markdown tables, written to
 * `_system/index.md`. Deterministic snapshot from live state.
 *
 * Excluded from the catalog:
 *   - `system:*` pages — host-owned bookkeeping (the index + timeline
 *     themselves); they never appear in their own catalog.
 *   - archived notes — restoring one re-introduces it on the next
 *     rebuild.
 *
 * Per-column source (mirrors the prior wiki-only builder so summaries
 * stay stable across the widening):
 *   - Path    : `pathForDoc(doc)` → the note's vault-relative address.
 *   - Title   : `KnownDoc.title`, else the path basename (dailies).
 *   - Summary : `sidecar.aiSummary` → body's first content line after
 *               the title ({@link bodyExcerpt}) → `(empty)` placeholder
 *               (the row still proves the note exists).
 *   - Links   : backlink count from {@link countBacklinks}.
 *
 * Notes without a resolvable path (a writing whose parent daily is
 * missing, etc.) are skipped silently. */
export async function buildWikiIndex(): Promise<string> {
  const store = useDocsStore.getState()
  const catalog = store.knownDocs
  const getDoc = (slug: string) => catalog.find((d) => d.slug === slug)
  // Everything the map catalogs: every non-archived note that isn't a
  // host-owned system page.
  const indexed = catalog.filter(
    (d) => !d.archivedAt && !d.type.startsWith('system:'),
  )

  // Pre-fetch bodies (in-memory handles, sync) for the WHOLE non-
  // archived catalog — countBacklinks counts links FROM any page
  // (including `system:log`, per its contract), so it needs more than
  // the indexed subset as sources. Sidecars (tiny JSON) only for the
  // indexed rows, read in parallel.
  const bodies: Record<string, string> = {}
  for (const d of catalog) {
    if (!d.archivedAt) bodies[d.slug] = readWikiMarkdown(d.slug)
  }
  const counts = countBacklinks(catalog, (slug) => bodies[slug])
  const sidecars = await Promise.all(indexed.map((d) => readWikiSidecar(d)))

  const knowledgeFolder = KNOWLEDGE_BASE_FOLDER
  const captureFolder = getDefaultNoteFolder()

  // Bucket rows by folder section.
  const bySection = new Map<string, IndexRow[]>()
  for (let i = 0; i < indexed.length; i++) {
    const doc = indexed[i]
    const path = computePathForDoc(doc, getDoc)
    if (!path) continue
    const body = bodies[doc.slug] ?? ''
    const summary =
      sidecars[i]?.aiSummary?.trim() || bodyExcerpt(body) || EMPTY_PLACEHOLDER
    const title = (doc.title ?? '').trim() || basenameNoExt(path)
    const row: IndexRow = {
      path,
      title,
      summary: truncate(summary, SUMMARY_MAX_LEN),
      links: counts.get(doc.slug) ?? 0,
    }
    const key = folderOf(path)
    let rows = bySection.get(key)
    if (!rows) {
      rows = []
      bySection.set(key, rows)
    }
    rows.push(row)
  }

  // Bucket non-note attachments (pdf/image/…) by the same folder key.
  // `knownFiles` is already sidecar-free (see isAttachmentFile); we only
  // drop host-owned areas the map doesn't catalog.
  const attachBySection = new Map<string, string[]>()
  for (const file of store.knownFiles) {
    if (file.startsWith('_system/') || file.startsWith('threads/')) continue
    const key = folderOf(file)
    let list = attachBySection.get(key)
    if (!list) {
      list = []
      attachBySection.set(key, list)
    }
    list.push(file)
  }

  // Folders the user made that hold no catalogued note or attachment —
  // kept as empty sections because the folder itself is intent (a place
  // to file into). `knownFolders` includes empties the file scan alone
  // can't see.
  const populated = new Set<string>([
    ...bySection.keys(),
    ...attachBySection.keys(),
  ])
  const emptyFolders = pickEmptyFolders(store.knownFolders, populated)

  const folders = new Set<string>([...populated, ...emptyFolders])
  const sections: IndexSection[] = [...folders].map((folder) => ({
    folder,
    role:
      folder === knowledgeFolder
        ? 'knowledge base'
        : folder === captureFolder
          ? 'capture'
          : null,
    // Stable within-section order so the persisted file doesn't churn.
    rows: (bySection.get(folder) ?? []).sort((a, b) =>
      a.title.localeCompare(b.title),
    ),
    attachments: (attachBySection.get(folder) ?? []).sort((a, b) =>
      a.localeCompare(b),
    ),
  }))

  return renderVaultIndex(
    orderSections(sections, knowledgeFolder, captureFolder),
  )
}

/** Pick the folders to render as empty sections: every known folder
 * that (a) isn't already populated with notes/attachments, (b) has no
 * populated folder nested under it (so a parent like `research/` isn't
 * flagged empty just because its notes live in `research/2024/`), and
 * (c) isn't a host-owned / dated area the map doesn't catalog
 * (`_system`, `threads`, `daily` and its subfolders, and the vault
 * root). Pure — exported for unit tests. */
export function pickEmptyFolders(
  knownFolders: string[],
  populated: Set<string>,
): string[] {
  const hasPopulatedDescendant = (folder: string): boolean => {
    const prefix = folder + '/'
    for (const p of populated) if (p.startsWith(prefix)) return true
    return false
  }
  return knownFolders.filter((folder) => {
    if (folder === '' || folder === '_system' || folder === 'threads') return false
    if (folder.startsWith('_system/') || folder.startsWith('threads/')) return false
    if (folder === 'daily' || folder.startsWith('daily/')) return false
    if (populated.has(folder)) return false
    if (hasPopulatedDescendant(folder)) return false
    return true
  })
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
