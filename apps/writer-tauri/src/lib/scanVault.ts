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

import { generateClientSlug } from '@/lib/slug'
import { getActiveVaultPath } from '@/state/settingsStore'
import { listVaultTreeRecursive, readVaultFile } from '@/lib/vault'
import type { KnownDoc } from '@/state/docsStore'
import { frontmatterToMeta, type DocMetaFile } from '@/lib/docPaths'
import { fmEntriesFromData, type FmEntry } from '@/lib/docProperties'
import { seedLastWrittenPath } from '@/lib/docFileSync'
import { splitFrontmatterFull } from '@/lib/frontmatter'

/** Mint a fresh slug for `mdRel` and load its portable frontmatter meta.
 *
 * The slug is an EPHEMERAL in-session handle — re-minted on every scan,
 * never persisted, never written to the file. Identity across restarts is
 * the file PATH (the persisted UI state is path-keyed — see persistConfig /
 * lib/lastView); the slug only has to be stable within one session, which
 * it is. `meta` carries the portable frontmatter fields (sourceUrl, videoId,
 * created, highlights, …); the file is never mutated here, so foreign notes
 * stay byte-for-byte the user's. */
async function mintDocMeta(
  mdRel: string,
): Promise<{ slug: string; meta: Partial<DocMetaFile>; fm?: FmEntry[] }> {
  let data: Record<string, string | string[]> = {}
  try {
    data = splitFrontmatterFull(await readVaultFile(mdRel)).data
  } catch {
    // Unreadable `.md` — mint anyway with empty meta.
  }
  // `meta` is the typed projection (allow-listed fields); `fm` retains
  // EVERY parsed key in file order for the properties panel. Same single
  // parse feeds both — no extra read.
  return { slug: generateClientSlug(), meta: frontmatterToMeta(data), fm: fmEntriesFromData(data) }
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
  allowGeneric = false,
  fm?: FmEntry[],
): KnownDoc | null {
  const base = mdRelToBaseDoc(slug, mdRel, dailySlugByDate, allowGeneric)
  if (!base) return null
  // Sidecar-stored fields layer onto the path-derived base so soft
  // state (archive flag, title intent) survives the boot rebuild that
  // would otherwise only see the filesystem.
  const overlay: Partial<KnownDoc> = {}
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
  // YouTube capture metadata (type 'youtube'). Harmless on other types —
  // their frontmatter/sidecar never carries these.
  if (typeof meta.videoId === 'string') overlay.videoId = meta.videoId
  if (typeof meta.durationSec === 'number') overlay.durationSec = meta.durationSec
  if (typeof meta.thumbnailUrl === 'string') overlay.thumbnailUrl = meta.thumbnailUrl
  if (typeof meta.description === 'string') overlay.description = meta.description
  // Workflow status — already validated to a known value by frontmatterToMeta.
  if (meta.status) overlay.status = meta.status
  // Tags list (already normalized to a non-empty string[] by frontmatterToMeta).
  if (meta.tags) overlay.tags = meta.tags
  // Full ordered frontmatter mirror for the properties panel.
  if (fm) overlay.fm = fm
  return { ...base, ...overlay } as KnownDoc
}

function mdRelToBaseDoc(
  slug: string,
  mdRel: string,
  dailySlugByDate: Map<string, string>,
  allowGeneric = false,
): KnownDoc | null {
  // wiki/<title>.md — no nesting beyond one level.
  const wikiMatch = mdRel.match(/^wiki\/([^/]+)\.md$/)
  if (wikiMatch) {
    const title = wikiMatch[1]
    // The self-profile page is a singleton the rest of the app keys off by
    // the fixed type `wiki:profile` (readSelfProfile, ensureProfileWikiSlug,
    // WIKI_PROFILE_POLICY, the profile pipeline, ingest routing). Recognise
    // it here by its canonical path so scan and those consumers agree on ONE
    // identity. Without this the scan registers it as `wiki:custom-*`,
    // ensureSystemPage can't find it, mints a SECOND `wiki:profile` doc for
    // the same file, and the slug churns — breaking edits to the profile.
    // `pathForDoc(wiki:profile)` returns `wiki/Profile.md`, so this round-trips.
    if (title === 'Profile') {
      return { slug, type: 'wiki:profile', title }
    }
    return {
      slug,
      type: `wiki:custom-${slug}` as KnownDoc['type'],
      title,
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
  // inbox/<title>.md (or legacy articles/<title>.md) — a captured item:
  // a saved web page or a YouTube capture. Both are generic notes; their
  // KIND is carried in frontmatter (sourceUrl = saved page, videoId =
  // video), layered on by mdRelToKnownDoc. The path IS the placement, so
  // relPath is set even though it's a recognised folder — pathForDoc
  // returns it verbatim and the file never moves.
  const captureMatch = mdRel.match(/^(?:inbox|articles)\/([^/]+)\.md$/)
  if (captureMatch) {
    return { slug, type: 'note', title: captureMatch[1], relPath: mdRel }
  }
  // Generic note: any other `.md` in the vault. The path is the
  // placement, carried on relPath; the title is the filename. Always on
  // now (flat vault) — `allowGeneric` stays a parameter only so the
  // unit tests can still exercise the recognised-folders-only path.
  if (allowGeneric) {
    const name = mdRel.split('/').pop()?.replace(/\.md$/, '') ?? mdRel
    return { slug, type: 'note', title: name, relPath: mdRel }
  }
  return null
}

/** Scan the active vault: every recognised doc as a KnownDoc, plus the folder
 * and attachment inventories the sidebar tree needs. All three come from ONE
 * traversal (`listVaultTreeRecursive`) — boot used to walk the whole tree
 * twice, once here and once for the tree, paying every `readDir` two times.
 * Everything empty when no vault is selected; the caller decides whether to
 * prompt for one. Slugs are ephemeral: each scan mints fresh ones (identity
 * across restarts is the file path, not the slug). */
export async function scanVault(): Promise<{
  docs: KnownDoc[]
  dirs: string[]
  files: string[]
}> {
  if (!getActiveVaultPath()) return { docs: [], dirs: [], files: [] }

  // Flat Obsidian-style vault: walk the WHOLE vault so every `.md`
  // surfaces in the catalog (recognised folders keep their special
  // classification; anything else becomes a generic `note` at its
  // relPath). Always on now that the folder tree is the only sidebar.
  const { dirs, files, notes: allMd } = await listVaultTreeRecursive()

  // Pass 1: mint a fresh ephemeral slug + load portable meta for every
  // file. Done up-front because pass-2's writing-note resolution needs the
  // daily date→slug map built from this pass.
  const scanned: Array<{
    slug: string
    mdRel: string
    meta: Partial<DocMetaFile>
    fm?: FmEntry[]
  }> = []
  for (const mdRel of allMd) {
    const { slug, meta, fm } = await mintDocMeta(mdRel)
    scanned.push({ slug, mdRel, meta, fm })
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
  for (const { slug, mdRel, meta, fm } of scanned) {
    const doc = mdRelToKnownDoc(slug, mdRel, dailySlugByDate, meta, true, fm)
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

  return { docs, dirs, files }
}

/** Build a KnownDoc for a single externally-created `.md` file. Used
 * by the vault watcher's `add` handler when Finder / vim / git drops
 * a new file into the vault: we need the same slug-assignment +
 * placement-classification pipeline scanVault runs at boot, but on a
 * single path instead of the whole tree.
 *
 * Returns null when the path doesn't fit any placement rule (oddly-
 * located file the watcher should ignore). Mints a fresh ephemeral slug
 * (nothing persisted — identity is the path).
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
  const { slug, meta, fm } = await mintDocMeta(mdRel)
  const dailySlugByDate = new Map<string, string>()
  for (const d of catalog) {
    if (d.type === 'daily' && d.date) dailySlugByDate.set(d.date, d.slug)
  }
  return mdRelToKnownDoc(slug, mdRel, dailySlugByDate, meta, true, fm)
}

// Dev-only console handle. `await __scanVault()` to inspect what the
// boot-time vault scan would currently see.
if (import.meta.env.DEV) {
  ;(window as unknown as { __scanVault: typeof scanVault }).__scanVault = scanVault
}
