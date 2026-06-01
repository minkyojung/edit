// Vault → catalog scan.
//
// In Path C (file-first architecture) the vault folder IS the catalog
// — there is no separate `knownDocs` persistence. This module turns a
// vault into the array shape the rest of the app already consumes,
// without changing the consumer surface.
//
// Identity rule:
//   The doc's slug is stored in its sidecar (`.marks.json`). A file
//   with no sidecar yet (created by vim / git / a previous version of
//   the app) gets a fresh slug assigned + a sidecar written, so the
//   identity stabilises on first sight. After that scan, the same
//   file always resolves to the same slug.
//
// Path → type derivation:
//   wiki/X.md                  →  type=`wiki:custom-${slug}`, title=X
//   daily/YYYY-MM-DD.md        →  type='daily',  date=YYYY-MM-DD
//   daily/YYYY-MM-DD/Y.md      →  type='writing', parentId=daily-slug, title=Y
//   _system/X.md               →  type=`system:X`
//
// Files outside this pattern (e.g. `wiki/sub/Page.md`, deeply nested
// writings, daily files with bad date format) are skipped silently.
// The vault is a user surface — odd files shouldn't crash boot.

import { readDir } from '@tauri-apps/plugin-fs'
import { join } from '@tauri-apps/api/path'
import { generateClientSlug } from '@/lib/slug'
import { getActiveVaultPath } from '@/state/settingsStore'
import {
  readVaultFile,
  vaultFileExists,
  writeVaultFile,
} from '@/lib/vault'
import type { KnownDoc } from '@/state/docsStore'
import type { DocMetaFile } from '@/lib/docPaths'
import { seedLastWrittenPath } from '@/lib/docFileSync'

/** Read the doc's persistent slug from its `.meta.json` sidecar, or
 * mint one + write the sidecar if missing. Two-tier lookup:
 *
 *   1. `.meta.json` exists with a `slug` field — return it.
 *   2. Sidecar missing (vim / git created a `.md` directly, or first
 *      scan of a brand-new doc) — mint a slug, persist it.
 *
 * The Stage 3.2 `.marks.json` migration tier was removed in the
 * `export/` cleanup: by that point every doc had already received a
 * `.meta.json` during the prior scan, so the legacy reader had no
 * remaining work. */
/** Returned by {@link getOrAssignSlug}: the slug to use plus the rest
 * of the sidecar payload so callers can hydrate non-identity fields
 * (archivedAt, archivedFromParent, aiSummary, …) without a second
 * file read. Empty when the sidecar was just minted. */
interface SidecarLoad {
  slug: string
  meta: Partial<DocMetaFile>
}

async function getOrAssignSlug(mdRel: string): Promise<SidecarLoad> {
  const metaRel = mdRel.replace(/\.md$/, '.meta.json')

  if (await vaultFileExists(metaRel)) {
    try {
      const raw = await readVaultFile(metaRel)
      const parsed = JSON.parse(raw) as Partial<DocMetaFile>
      if (typeof parsed.slug === 'string' && parsed.slug.length > 0) {
        return { slug: parsed.slug, meta: parsed }
      }
    } catch {
      // Corrupted .meta.json — fall through to mint a fresh slug.
    }
  }

  const slug = generateClientSlug()
  const meta: DocMetaFile = { version: 1, slug }
  await writeVaultFile(metaRel, `${JSON.stringify(meta, null, 2)}\n`)
  return { slug, meta }
}

/** Walk a vault subdirectory recursively and return every body-.md
 * file's path relative to the vault root. Sidecar files
 * (`.marks.json`) and hidden entries (`.DS_Store`, `.git/`, ...) are
 * filtered out at every level. */
async function listMdRecursive(subRel: string): Promise<string[]> {
  if (!(await vaultFileExists(subRel))) return []
  const root = getActiveVaultPath()
  if (!root) return []
  const absPath = await join(root, subRel)
  const entries = await readDir(absPath)
  const results: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const childRel = subRel === '' ? entry.name : `${subRel}/${entry.name}`
    if (entry.isDirectory) {
      const sub = await listMdRecursive(childRel)
      results.push(...sub)
    } else if (
      entry.name.endsWith('.md') &&
      !entry.name.endsWith('.marks.json')
    ) {
      results.push(childRel)
    }
  }
  return results
}

/** Build a KnownDoc from a path + slug. Returns null when the path
 * doesn't match any of our four placement rules (an oddly-located file
 * — skipped silently by the caller).
 *
 * `meta` carries the rest of the sidecar payload (archive flags, AI
 * fields, …). Soft-state fields from the sidecar are layered on top
 * of the path-derived base so a doc archived in a previous session
 * comes back archived after a restart. Path C: vault is the single
 * source of truth, so any state that must survive boot has to live
 * in either the disk layout or the sidecar.
 *
 * Exported for unit tests — the placement rules are the public
 * contract between disk layout and the in-memory catalog. */
export function mdRelToKnownDoc(
  slug: string,
  mdRel: string,
  dailySlugByDate: Map<string, string>,
  meta: Partial<DocMetaFile> = {},
): KnownDoc | null {
  const base = mdRelToBaseDoc(slug, mdRel, dailySlugByDate)
  if (!base) return null
  // Sidecar-stored fields layer onto the path-derived base so soft
  // state (archive flag, title intent) survives the boot rebuild that
  // would otherwise only see the filesystem.
  const overlay: Partial<KnownDoc> = {}
  if (typeof meta.archivedAt === 'number') {
    overlay.archivedAt = meta.archivedAt
  }
  if (typeof meta.archivedFromParent === 'string') {
    overlay.archivedFromParent = meta.archivedFromParent
  }
  // `titleIntent === 'empty'` means the on-disk filename is a system
  // fallback ('Untitled.md') rather than the user's chosen title.
  // Drop the filename-derived title so the EditableTitleInput renders
  // its placeholder instead of treating "Untitled" as the user's
  // input. Legacy sidecars (no titleIntent) are treated as 'set' —
  // they always carried a non-fallback filename.
  if (meta.titleIntent === 'empty') {
    overlay.title = undefined
  }
  // Phase 5b of the Yjs-removal migration: the doc's creation time
  // used to live in `Y.Map('meta').createdAt`; we now read it off
  // the sidecar so the catalog has it without touching Y.Doc.
  // Legacy sidecars lack the field — leaves overlay.createdAt
  // undefined and DocumentInfoDialog renders "—".
  if (typeof meta.createdAt === 'string') {
    overlay.createdAt = meta.createdAt
  }
  // Read-it-later article metadata. Only meaningful on type 'article',
  // but harmless to layer regardless — non-article sidecars never carry
  // these fields. Restores source URL / site / favicon / read state so
  // the queue survives the boot rebuild.
  if (typeof meta.sourceUrl === 'string') overlay.sourceUrl = meta.sourceUrl
  if (typeof meta.siteName === 'string') overlay.siteName = meta.siteName
  if (typeof meta.faviconUrl === 'string') overlay.faviconUrl = meta.faviconUrl
  if (typeof meta.savedAt === 'string') overlay.savedAt = meta.savedAt
  if (typeof meta.readAt === 'string') overlay.readAt = meta.readAt
  return { ...base, ...overlay } as KnownDoc
}

function mdRelToBaseDoc(
  slug: string,
  mdRel: string,
  dailySlugByDate: Map<string, string>,
): KnownDoc | null {
  // wiki/<title>.md — no nesting beyond one level.
  const wikiMatch = mdRel.match(/^wiki\/([^/]+)\.md$/)
  if (wikiMatch) {
    return {
      slug,
      type: `wiki:custom-${slug}` as KnownDoc['type'],
      title: wikiMatch[1],
    }
  }
  // daily/<YYYY-MM-DD>.md — strict date format gate so a stray
  // `daily/random.md` doesn't pose as a daily.
  const dailyMatch = mdRel.match(/^daily\/(\d{4}-\d{2}-\d{2})\.md$/)
  if (dailyMatch) {
    return { slug, type: 'daily', date: dailyMatch[1] }
  }
  // daily/<YYYY-MM-DD>/<title>.md — a writing note under a daily.
  // ParentId resolves to the daily's slug from the first-pass map; if
  // the daily isn't on disk (writing orphan), skip — we don't fabricate
  // a phantom parent.
  const writingMatch = mdRel.match(
    /^daily\/(\d{4}-\d{2}-\d{2})\/([^/]+)\.md$/,
  )
  if (writingMatch) {
    const [, date, title] = writingMatch
    const parentSlug = dailySlugByDate.get(date)
    if (!parentSlug) return null
    return { slug, type: 'writing', title, parentId: parentSlug }
  }
  // _system/<name>.md — a single agent-managed meta page.
  const systemMatch = mdRel.match(/^_system\/([^/]+)\.md$/)
  if (systemMatch) {
    return {
      slug,
      type: `system:${systemMatch[1]}` as KnownDoc['type'],
    }
  }
  // articles/<title>.md — a saved read-it-later page. Flat (no nesting).
  // Source metadata (url/site/favicon/read state) is layered from the
  // sidecar by mdRelToKnownDoc; the title comes from the filename.
  const articleMatch = mdRel.match(/^articles\/([^/]+)\.md$/)
  if (articleMatch) {
    return { slug, type: 'article', title: articleMatch[1] }
  }
  return null
}

/** Scan the active vault and return every recognised doc as a
 * KnownDoc. Empty array when no vault is selected — caller decides
 * whether to prompt for one. Idempotent: re-running on the same vault
 * produces the same slugs (sidecars persist them). */
export async function scanVault(): Promise<KnownDoc[]> {
  if (!getActiveVaultPath()) return []

  const allMd = [
    ...(await listMdRecursive('wiki')),
    ...(await listMdRecursive('daily')),
    ...(await listMdRecursive('_system')),
    ...(await listMdRecursive('articles')),
  ]

  // Pass 1: resolve slug + load sidecar metadata for every file in one
  // read. Done up-front because pass-2's writing-note resolution needs
  // the daily slug map, and pass-2 also needs the sidecar's soft-state
  // fields (archivedAt, …) to layer onto the path-derived KnownDoc.
  const scanned: Array<{
    slug: string
    mdRel: string
    meta: Partial<DocMetaFile>
  }> = []
  for (const mdRel of allMd) {
    const { slug, meta } = await getOrAssignSlug(mdRel)
    scanned.push({ slug, mdRel, meta })
  }

  // Daily index: date → slug. Built from the same scan so writings
  // resolve their parent without a second filesystem pass.
  const dailySlugByDate = new Map<string, string>()
  for (const { slug, mdRel } of scanned) {
    const m = mdRel.match(/^daily\/(\d{4}-\d{2}-\d{2})\.md$/)
    if (m) dailySlugByDate.set(m[1], slug)
  }

  // Pass 2: assemble KnownDoc entries. Unrecognised paths drop out.
  const docs: KnownDoc[] = []
  for (const { slug, mdRel, meta } of scanned) {
    const doc = mdRelToKnownDoc(slug, mdRel, dailySlugByDate, meta)
    if (doc) docs.push(doc)
  }

  // Seed the rename tracker so the first user rename after boot can
  // emit `fs.rename` against the existing file instead of writing a
  // fresh copy and orphaning the old one. Pre-Path-R0 this was lazily
  // populated by the first auto-flush; if the user renamed inside the
  // 2s window before that tick, the resulting orphan would resurface
  // on the next reload (scanVault picks the alphabetically first .md
  // when two share a slug). Seeding from disk closes that race.
  seedLastWrittenPath(scanned)

  return docs
}

/** Build a KnownDoc for a single externally-created `.md` file. Used
 * by the vault watcher's `add` handler when Finder / vim / git drops
 * a new file into the vault: we need the same slug-assignment +
 * placement-classification pipeline scanVault runs at boot, but on a
 * single path instead of the whole tree.
 *
 * Returns null when the path doesn't fit any placement rule (oddly-
 * located file the watcher should ignore). Mints + persists a fresh
 * `.meta.json` when none exists, so the next scan / restart reads
 * the same slug.
 *
 * For `writing` types the function needs to find the parent daily's
 * slug. Rather than re-scanning the disk we accept the live
 * knownDocs catalog and build the date→slug map in memory — the
 * catalog is the source of truth in-session, and the daily must
 * already be on disk for its child to be valid (or the writing is
 * an orphan we reject the same way scanVault does). */
export async function buildKnownDocForExternalPath(
  mdRel: string,
  catalog: KnownDoc[],
): Promise<KnownDoc | null> {
  const { slug, meta } = await getOrAssignSlug(mdRel)
  const dailySlugByDate = new Map<string, string>()
  for (const d of catalog) {
    if (d.type === 'daily' && d.date) dailySlugByDate.set(d.date, d.slug)
  }
  return mdRelToKnownDoc(slug, mdRel, dailySlugByDate, meta)
}

// Dev-only console handle. `await __scanVault()` to inspect what the
// boot-time vault scan would currently see.
if (import.meta.env.DEV) {
  ;(window as unknown as { __scanVault: typeof scanVault }).__scanVault = scanVault
}
