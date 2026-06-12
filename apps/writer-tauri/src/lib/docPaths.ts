// Doc → vault file path mapping.
//
// In Phase 4 the vault on disk becomes the source of truth for every
// app doc (wiki entry, daily journal, system meta page). Each doc
// type has its own subdirectory + naming convention so a user
// browsing ~/Documents/Writer/ in Finder gets an immediately
// recognisable layout:
//
//   wiki/Tom.md                        ← entity page (wiki:custom-*)
//   wiki/Tom.marks.json                ← sidecar
//   daily/2026-05-17.md                ← daily journal (daily)
//   daily/2026-05-17/My note.md        ← writing note under a daily
//   _system/conventions.md             ← agent-managed meta (system:*)
//
// Writing notes live in a per-day subfolder so they group with their
// daily on disk. The subfolder only materialises when the day has at
// least one child — empty days stay as a single file. Multi-level
// nesting (writing under writing under daily) flattens on disk: every
// descendant of the same daily becomes its sibling under that day's
// folder. The tree structure stays in `knownDocs.parentId` (UI source
// of truth); disk stays flat so CLI listing remains useful.
//
// This module is the only place those mappings are defined. Vault
// helpers (vault.ts) take vault-relative strings and don't care how
// they were composed; this file is where docsStore + ingest + the
// file watcher meet to agree on file naming.
//
// Pure functions only — no I/O. Tests can pass synthetic KnownDoc
// shapes without standing up the rest of the app.

import type { KnownDoc } from '@/state/docsStore'
import type { HighlightRecord } from '@/lib/highlightTypes'
import type { FrontmatterScalar } from '@/lib/frontmatter'

/**
 * Doc identity sidecar — the `<stem>.meta.json` file that scanVault
 * reads at boot to recover each doc's persistent slug across sessions
 * and external file moves.
 *
 * The mark data lives in `<stem>.ydoc` (Yjs binary); the `.meta.json`
 * sidecar carries only identity + lightweight LLM-context metadata.
 * Bumping `version` is the migration lever — a future field addition
 * reads as `undefined` on old files and the migrate step rewrites
 * with the new shape.
 *
 * `aiSummary` / `aiImportance` feed the Tier 1 wiki index without
 * forcing the index builder to LLM-summarise every page on every
 * boot. They're populated by the ingest post-pass; a missing value
 * falls back to the page's first non-empty body line at index time.
 */
export interface DocMetaFile {
  version: 1
  slug: string
  /** One-line LLM-generated summary used by the wiki index. ~80 chars.
   * Absent on old sidecars and freshly-minted docs; the index builder
   * falls back to the body's first non-empty line until ingest writes
   * a real summary. */
  aiSummary?: string
  /** 0–100 score used to rank pages when the Tier 2 hot-context
   * selector has to drop pages to stay under budget. Computed from
   * backlink count + recency; not user-editable. Absent on old
   * sidecars — treated as 0 (lowest priority) by the selector. */
  aiImportance?: number
  /** Soft-delete timestamp (epoch ms). Set when the user archives the
   * doc, cleared on unarchive. Persisted here because the catalog is
   * rebuilt from disk on every boot (Path C — vault is the source of
   * truth); without this field, archive state would silently revert
   * to "live" on app restart. */
  archivedAt?: number
  /** Pre-archive `parentId` snapshot, so unarchive can restore the
   * cascade group's tree structure. Lives in the same sidecar as
   * `archivedAt` to keep the archive state self-contained. */
  archivedFromParent?: string
  /** ISO timestamp recorded when the doc was first created. Migrated
   * out of `Y.Map('meta')` in Phase 5b of the Yjs-removal migration —
   * the Y.Map was the prior home for this field, but it's the only
   * piece of meta the path-derived catalog doesn't already carry, so
   * the sidecar is the natural permanent home. Absent on legacy
   * sidecars; DocumentInfoDialog falls back to "—". */
  createdAt?: string
  /** Read-it-later source metadata. Present on captured-from-URL notes
   * (saved web pages); a present `sourceUrl` is what marks a generic
   * `note` as a read-it-later item. Persisted in `.md` frontmatter so
   * source URL, site name, favicon, and read/unread state survive the
   * boot-time catalog rebuild. */
  sourceUrl?: string
  siteName?: string
  faviconUrl?: string
  savedAt?: string
  readAt?: string
  /** User highlights on a captured read-it-later note. Source of truth
   * for highlights — the editor re-anchors each to the body on mount. */
  highlights?: HighlightRecord[]
  /** YouTube capture metadata. A present `videoId` marks a generic `note`
   * as a video capture. Persisted in `.md` frontmatter; the field shape
   * is shared so the frontmatter ⇄ meta mapping has one definition. */
  videoId?: string
  durationSec?: number
  thumbnailUrl?: string
  /** Short summary shown as the reader "dek" under the title (the TL;DR
   * for a youtube capture). Lifted out of the body so the header can
   * render it styled, separate from the editable content. */
  description?: string
}

/** Lookup a doc by slug. Required by {@link pathForDoc} only for
 * `writing` docs (we need to walk parentId up to the daily ancestor
 * to pick the day folder). Other doc types ignore it. */
export type DocLookup = (slug: string) => KnownDoc | undefined

/** Vault-relative path of a doc's markdown body. Returns null when
 * the doc has no placement (a daily without a date, a writing whose
 * parent chain doesn't reach a daily). */
export function pathForDoc(doc: KnownDoc, getDoc?: DocLookup): string | null {
  if (doc.type === 'daily') {
    if (!doc.date) return null
    return `daily/${doc.date}.md`
  }
  if (doc.type.startsWith('system:')) {
    const name = doc.type.slice('system:'.length)
    return `_system/${sanitizeFilename(name)}.md`
  }
  if (doc.type.startsWith('wiki:')) {
    const filename = sanitizeFilename(doc.title?.trim() || 'Untitled')
    return `wiki/${filename}.md`
  }
  if (doc.type === 'writing') {
    if (!getDoc) return null
    const dailyAncestor = findDailyAncestor(doc, getDoc)
    if (!dailyAncestor?.date) return null
    const filename = sanitizeFilename(doc.title?.trim() || 'Untitled')
    return `daily/${dailyAncestor.date}/${filename}.md`
  }
  // Generic note: the file lives wherever the user put it, so its stored
  // relative path IS the placement (no folder/name convention to apply).
  // Inbox captures (saved pages / youtube) are notes too — their relPath
  // is `inbox/<title>.md`, set at creation.
  if (doc.type === 'note') {
    return doc.relPath ?? null
  }
  return null
}

/** True when a doc stores its metadata inside its own `.md` frontmatter
 * rather than a `.meta.json` sidecar. YouTube captures are the first
 * (and currently only) frontmatter-native type; every other type keeps
 * Every doc is now frontmatter-native — metadata lives in the `.md`'s
 * `---` block, no `.meta.json` sidecar. The flush writer (`docFileSync`)
 * and the body loader (`handlesSlice`) both gate on this. Kept as a
 * function (rather than inlining `true`) so the one remaining sidecar
 * holdout, if any ever returns, has a single switch. */
export function usesFrontmatter(_doc: Pick<KnownDoc, 'type'>): boolean {
  return true
}

/** Coerce a parsed frontmatter block (whose values are all raw strings)
 * into the sidecar-shaped meta the catalog overlay reads. Numeric fields
 * are parsed; unrecognised keys are ignored. Mirrors exactly the fields
 * `mdRelToKnownDoc` layers, so a doc whose metadata lives in frontmatter
 * rebuilds identically to one whose metadata lives in a `.meta.json`
 * sidecar.
 *
 * `highlights` is intentionally omitted: it's a nested array that doesn't
 * fit a flat frontmatter block, and no frontmatter-stored doc type uses
 * it yet. */
export function frontmatterToMeta(
  data: Record<string, string>,
): Partial<DocMetaFile> {
  const meta: Partial<DocMetaFile> = {}
  if (data.slug) meta.slug = data.slug
  if (data.createdAt) meta.createdAt = data.createdAt
  if (data.archivedAt) {
    const n = Number(data.archivedAt)
    if (Number.isFinite(n)) meta.archivedAt = n
  }
  if (data.archivedFromParent) meta.archivedFromParent = data.archivedFromParent
  if (data.aiSummary) meta.aiSummary = data.aiSummary
  if (data.aiImportance) {
    const n = Number(data.aiImportance)
    if (Number.isFinite(n)) meta.aiImportance = n
  }
  if (data.sourceUrl) meta.sourceUrl = data.sourceUrl
  if (data.siteName) meta.siteName = data.siteName
  if (data.faviconUrl) meta.faviconUrl = data.faviconUrl
  if (data.savedAt) meta.savedAt = data.savedAt
  if (data.readAt) meta.readAt = data.readAt
  if (data.videoId) meta.videoId = data.videoId
  if (data.durationSec) {
    const n = Number(data.durationSec)
    if (Number.isFinite(n)) meta.durationSec = n
  }
  if (data.thumbnailUrl) meta.thumbnailUrl = data.thumbnailUrl
  if (data.description) meta.description = data.description
  return meta
}

/** Inverse of {@link frontmatterToMeta}: project the sidecar-shaped meta
 * onto the flat frontmatter fields we emit when a doc stores its metadata
 * in its own `.md` instead of a `.meta.json` sidecar.
 *
 * `version` and `highlights` are dropped — the former is sidecar-only
 * bookkeeping, the latter is a nested array that doesn't fit a flat
 * block. Undefined fields are returned as-is; `composeFrontmatter` skips
 * them, so the caller can hand over the whole record.
 *
 * Kept beside `frontmatterToMeta` on purpose: the two field lists must
 * stay in lockstep, and the round-trip test pins them together so adding
 * a field to one without the other fails CI rather than silently dropping
 * metadata on save. */
export function metaToFrontmatterFields(
  meta: Partial<DocMetaFile>,
): Record<string, FrontmatterScalar | undefined> {
  return {
    slug: meta.slug,
    createdAt: meta.createdAt,
    archivedAt: meta.archivedAt,
    archivedFromParent: meta.archivedFromParent,
    aiSummary: meta.aiSummary,
    aiImportance: meta.aiImportance,
    sourceUrl: meta.sourceUrl,
    siteName: meta.siteName,
    faviconUrl: meta.faviconUrl,
    savedAt: meta.savedAt,
    readAt: meta.readAt,
    videoId: meta.videoId,
    durationSec: meta.durationSec,
    thumbnailUrl: meta.thumbnailUrl,
    description: meta.description,
  }
}

/** Reverse of {@link pathForDoc}: given a vault-relative path,
 * return the matching doc's slug, or null when no known doc maps
 * to it. O(n) over `knownDocs` — fine for the intended callers
 * (one-off click handlers, not hot loops). Trusts pathForDoc as
 * the single forward mapping so the rules don't get duplicated
 * (scanVault.ts's mdRelToKnownDoc has its own boot-time parser,
 * but it works against parsed paths the scanner produced; the
 * runtime case here is "the LLM gave us a path string, which
 * doc does it belong to?" — different shape, same routing). */
export function pathToKnownSlug(
  relPath: string,
  knownDocs: readonly KnownDoc[],
): string | null {
  const getDoc = (s: string) => knownDocs.find((d) => d.slug === s)
  for (const doc of knownDocs) {
    if (pathForDoc(doc, getDoc) === relPath) return doc.slug
  }
  return null
}

/** Vault-relative path of a doc's identity sidecar file. Same stem
 * as the markdown body, `.meta.json` suffix. Contains the doc's
 * persistent slug so scanVault can recover identity across restarts.
 *
 * Path C Stage 3: renamed from `.marks.json` to `.meta.json` since
 * the file no longer carries mark data — those moved into the `.ydoc`
 * binary. Returns null when {@link pathForDoc} returns null. */
export function metaPathForDoc(doc: KnownDoc, getDoc?: DocLookup): string | null {
  const md = pathForDoc(doc, getDoc)
  if (!md) return null
  return md.replace(/\.md$/, '.meta.json')
}

/** Vault-relative path of a doc's Y.Doc binary sidecar. Same stem as
 * the markdown body, `.ydoc` suffix instead of `.md`. Stores the full
 * Yjs CRDT state — body fragment + marks Y.Map + RelativePositions —
 * so cross-restart mark anchoring survives without text-search
 * fragility. Returns null when {@link pathForDoc} returns null. */
export function ydocPathForDoc(doc: KnownDoc, getDoc?: DocLookup): string | null {
  const md = pathForDoc(doc, getDoc)
  if (!md) return null
  return md.replace(/\.md$/, '.ydoc')
}

/** Walk parentId up the chain until we hit a daily. Returns null if
 * the chain ends without one (orphan writing) or contains a cycle
 * (defensive — KnownDoc invariants forbid it, but we don't want a
 * pathological catalog to lock up the call site).
 *
 * Archived writings have their `parentId` cleared (so the tree UI
 * doesn't show them under a live daily) and the original parent
 * snapshotted in `archivedFromParent`. We fall back to that snapshot
 * so the archived doc still resolves to its on-disk location — the
 * sidecar lives next to the body file, and the flush needs the path
 * to write the archive marker. */
function findDailyAncestor(doc: KnownDoc, getDoc: DocLookup): KnownDoc | null {
  const visited = new Set<string>()
  let current: KnownDoc | undefined = doc
  while (current && !visited.has(current.slug)) {
    visited.add(current.slug)
    if (current.type === 'daily') return current
    const parentId = current.parentId ?? current.archivedFromParent
    if (!parentId) return null
    current = getDoc(parentId)
  }
  return null
}

/** Strip filesystem-reserved characters from a filename component.
 * The set is the union of what Windows, macOS, and Linux refuse —
 * forward slash + backslash split into segments, the others are
 * forbidden on Windows in particular. Trims whitespace and falls
 * back to `'Untitled'` when nothing remains so callers never write
 * a file with an empty stem.
 *
 * Allowed: Unicode word characters (Hangul / CJK / Latin), spaces,
 * hyphens, underscores, dots inside the name. We do NOT lowercase
 * — Karpathy / Bear / Obsidian all keep title case (`Tom.md` not
 * `tom.md`) so the filename reads like the page name. */
export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[/\\:*?"<>|]/g, '-').trim()
  return cleaned.length > 0 ? cleaned : 'Untitled'
}
