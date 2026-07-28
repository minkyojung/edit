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
import type { FrontmatterValue } from '@/lib/frontmatter'
import { normalizeTags } from '@/lib/tags'

/**
 * A note's workflow status. Optional per note; a note carries no `status`
 * until one is set. Stable English values persist to `.md` frontmatter;
 * the Korean display labels live only in the UI layer. `DOC_STATUS_VALUES`
 * is a runtime `const` because {@link frontmatterToMeta} validates against
 * it — a stored value that isn't one of these is dropped on read.
 */
export const DOC_STATUS_VALUES = ['not-started', 'in-progress', 'done'] as const
export type DocStatus = (typeof DOC_STATUS_VALUES)[number]

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
 */
export interface DocMetaFile {
  version: 1
  slug: string
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
  /** Workflow status (not-started / in-progress / done). Optional and
   * user-facing: set via the header badge or the AI `set_note_status`
   * tool, shown as a badge + a sidebar dot. Only editable note types
   * carry it — see `docSupportsStatus`. */
  status?: DocStatus
  /** Free-form tags, persisted to `.md` frontmatter as a YAML list
   * (`tags:\n  - a\n  - b`). User-facing and editable via the properties
   * panel. Empty/absent when the note has no tags. */
  tags?: string[]
}

/** Lookup a doc by slug. Required by {@link pathForDoc} only for
 * `writing` docs (we need to walk parentId up to the daily ancestor
 * to pick the day folder). Other doc types ignore it. */
export type DocLookup = (slug: string) => KnownDoc | undefined

/** Vault-relative path of the doc with this slug, or null when the slug isn't
 * in the catalog or the doc has no placement.
 *
 * Sugar over {@link pathForDoc} for the very common "I have a slug and the
 * catalog" case, which otherwise expands to the same two lines — find the doc,
 * then hand it a `find`-based lookup for the writing-ancestor walk — at every
 * call site. Linear in `knownDocs` (twice over for a `writing` doc): fine for
 * one slug per render, but build a Map first if you're resolving many at once
 * (FolderTree and CommandPalette both do). */
export function pathForSlug(slug: string | null, knownDocs: KnownDoc[]): string | null {
  if (!slug) return null
  const doc = knownDocs.find((d) => d.slug === slug)
  if (!doc) return null
  return pathForDoc(doc, (s) => knownDocs.find((d) => d.slug === s))
}

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

/** Coerce a parsed frontmatter block into the sidecar-shaped meta the
 * catalog overlay reads. Input comes from `parseFrontmatterFull`, so scalar
 * fields arrive as strings and list fields (`tags`) as `string[]`; each read
 * guards its own type so a malformed value (e.g. a scalar key written as a
 * list) is dropped rather than mis-assigned. Numeric fields are parsed;
 * unrecognised keys are ignored. Mirrors exactly the fields `mdRelToKnownDoc`
 * layers. */
export function frontmatterToMeta(
  data: Record<string, string | string[]>,
): Partial<DocMetaFile> {
  const meta: Partial<DocMetaFile> = {}
  const str = (v: string | string[] | undefined): string | undefined =>
    typeof v === 'string' ? v : undefined

  // Plain string fields: copy each through when it's present as a string. A
  // malformed value (e.g. a scalar key hand-written as a YAML list) reads as
  // a non-string and is dropped rather than mis-assigned.
  const STRING_KEYS = [
    'slug',
    'siteName',
    'faviconUrl',
    'savedAt',
    'readAt',
    'videoId',
    'thumbnailUrl',
    'description',
  ] as const
  for (const key of STRING_KEYS) {
    const s = str(data[key])
    if (s) meta[key] = s
  }

  // Portable fields carry an Obsidian-standard name on disk (`created`,
  // `source`) but land on the app's own camelCase meta fields. We accept
  // the legacy `createdAt`/`sourceUrl` keys too so notes written before the
  // rename still read; the write path re-emits the standard name, migrating
  // each note the next time it's saved.
  const createdAt = str(data.created) ?? str(data.createdAt)
  if (createdAt) meta.createdAt = createdAt
  const sourceUrl = str(data.source) ?? str(data.sourceUrl)
  if (sourceUrl) meta.sourceUrl = sourceUrl

  const dur = str(data.durationSec)
  if (dur) {
    const n = Number(dur)
    if (Number.isFinite(n)) meta.durationSec = n
  }
  // status must be one of the known values; anything else is dropped.
  const status = str(data.status)
  if (status && (DOC_STATUS_VALUES as readonly string[]).includes(status)) {
    meta.status = status as DocStatus
  }
  // Tags: a YAML list, or a scalar `tags: foo` treated as one item. Runs the
  // same normalization (trim / de-dupe) as the write path so a note read from
  // disk matches one written in-app.
  const rawTags = Array.isArray(data.tags)
    ? data.tags
    : str(data.tags)
      ? [str(data.tags) as string]
      : []
  const tags = normalizeTags(rawTags)
  if (tags.length) meta.tags = tags

  return meta
}

/** Fresh projection of a parsed frontmatter block onto the doc-catalog
 * metadata fields, with every projectable field explicitly present (as
 * `undefined` when absent). Spreading the result over an existing KnownDoc
 * therefore CLEARS fields the external edit removed — e.g. deleting
 * `status:` in Obsidian clears the badge on reload. scanVault's boot
 * overlay can't be reused for this: it's set-only, which is fine on a
 * fresh base row but would leave stale values behind on a live one.
 * Used by reloadFromVault. Kept beside {@link frontmatterToMeta} so the
 * projected field list stays in lockstep. */
export function frontmatterDocOverlay(data: Record<string, string | string[]>): {
  createdAt: string | undefined
  sourceUrl: string | undefined
  siteName: string | undefined
  faviconUrl: string | undefined
  savedAt: string | undefined
  readAt: string | undefined
  videoId: string | undefined
  durationSec: number | undefined
  thumbnailUrl: string | undefined
  description: string | undefined
  status: DocStatus | undefined
  tags: string[] | undefined
} {
  const meta = frontmatterToMeta(data)
  return {
    createdAt: meta.createdAt,
    sourceUrl: meta.sourceUrl,
    siteName: meta.siteName,
    faviconUrl: meta.faviconUrl,
    savedAt: meta.savedAt,
    readAt: meta.readAt,
    videoId: meta.videoId,
    durationSec: meta.durationSec,
    thumbnailUrl: meta.thumbnailUrl,
    description: meta.description,
    status: meta.status,
    tags: meta.tags,
  }
}

/** Inverse of {@link frontmatterToMeta}: project the sidecar-shaped meta
 * onto the flat frontmatter fields we emit when a doc stores its metadata
 * in its own `.md` instead of a `.meta.json` sidecar.
 *
 * `version` is dropped (sidecar-only bookkeeping). Undefined fields are
 * returned as-is; `composeFrontmatter` skips them, so the caller can hand
 * over the whole record.
 *
 * Kept beside `frontmatterToMeta` on purpose: the two field lists must
 * stay in lockstep, and the round-trip test pins them together so adding
 * a field to one without the other fails CI rather than silently dropping
 * metadata on save. */
export function metaToFrontmatterFields(
  meta: Partial<DocMetaFile>,
): Record<string, FrontmatterValue | undefined> {
  return {
    slug: meta.slug,
    // Obsidian-standard names on disk (see frontmatterToMeta for the read side).
    created: meta.createdAt,
    source: meta.sourceUrl,
    siteName: meta.siteName,
    faviconUrl: meta.faviconUrl,
    savedAt: meta.savedAt,
    readAt: meta.readAt,
    videoId: meta.videoId,
    durationSec: meta.durationSec,
    thumbnailUrl: meta.thumbnailUrl,
    description: meta.description,
    status: meta.status,
    tags: meta.tags,
  }
}

/** The portable subset of {@link metaToFrontmatterFields}: the fields that
 * belong in the user's `.md` because another tool (Obsidian, git) or a
 * human can read them — created date, capture source, and video metadata.
 *
 * Excludes the app-private `slug` — an ephemeral per-boot handle that is
 * never persisted (identity across restarts is the file path). Used by the
 * flush so a saved `.md` carries only what's genuinely the user's. Kept in
 * lockstep with metaToFrontmatterFields — the two must not disagree on where
 * a field belongs. */
export function portableFrontmatterFields(
  meta: Partial<DocMetaFile>,
): Record<string, FrontmatterValue | undefined> {
  return {
    // Obsidian-standard names on disk. The legacy `createdAt`/`sourceUrl`
    // keys — and the app-private `slug` some pre-cleanup notes still
    // carry — are listed as `undefined` so mergeFrontmatter treats them
    // as app-owned and drops any stale copy: a lazy per-note migration
    // on the next save, no bulk rewrite.
    created: meta.createdAt,
    createdAt: undefined,
    source: meta.sourceUrl,
    sourceUrl: undefined,
    slug: undefined,
    siteName: meta.siteName,
    faviconUrl: meta.faviconUrl,
    savedAt: meta.savedAt,
    readAt: meta.readAt,
    videoId: meta.videoId,
    durationSec: meta.durationSec,
    thumbnailUrl: meta.thumbnailUrl,
    description: meta.description,
    status: meta.status,
    tags: meta.tags,
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

/** Walk parentId up the chain until we hit a daily. Returns null if
 * the chain ends without one (orphan writing) or contains a cycle
 * (defensive — KnownDoc invariants forbid it, but we don't want a
 * pathological catalog to lock up the call site).
 *
 */
function findDailyAncestor(doc: KnownDoc, getDoc: DocLookup): KnownDoc | null {
  const visited = new Set<string>()
  let current: KnownDoc | undefined = doc
  while (current && !visited.has(current.slug)) {
    visited.add(current.slug)
    if (current.type === 'daily') return current
    const parentId = current.parentId
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
