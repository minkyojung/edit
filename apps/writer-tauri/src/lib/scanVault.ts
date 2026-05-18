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
import type { DocMetaFile, MarksSidecarFile } from '@/export/types'

/** Read the doc's persistent slug from its on-disk meta sidecar, or
 * mint one + write it back if missing. Three-tier lookup:
 *
 *   1. `.meta.json` (current) — slim file with just the slug
 *   2. `.marks.json` (Stage 3 migration) — legacy sidecar; read slug
 *      out of it, write a fresh `.meta.json` so future scans skip the
 *      legacy path
 *   3. neither exists — externally created file; mint a slug, write
 *      `.meta.json`, identity stabilises on this scan
 *
 * Legacy `.marks.json` files are LEFT IN PLACE on disk — flushDirty
 * stops writing them but doesn't actively delete user files. They
 * become inert and the user can clean them up manually. */
async function getOrAssignSlug(mdRel: string): Promise<string> {
  const metaRel = mdRel.replace(/\.md$/, '.meta.json')
  const legacyRel = mdRel.replace(/\.md$/, '.marks.json')

  // Tier 1 — current .meta.json.
  if (await vaultFileExists(metaRel)) {
    try {
      const raw = await readVaultFile(metaRel)
      const parsed = JSON.parse(raw) as Partial<DocMetaFile>
      if (typeof parsed.slug === 'string' && parsed.slug.length > 0) {
        return parsed.slug
      }
    } catch {
      // Corrupted .meta.json — fall through to legacy / fresh.
    }
  }

  // Tier 2 — legacy .marks.json migration. Read the slug, write a
  // fresh .meta.json so subsequent scans see the canonical file.
  if (await vaultFileExists(legacyRel)) {
    try {
      const raw = await readVaultFile(legacyRel)
      const parsed = JSON.parse(raw) as Partial<MarksSidecarFile>
      if (typeof parsed.slug === 'string' && parsed.slug.length > 0) {
        const meta: DocMetaFile = { version: 1, slug: parsed.slug }
        await writeVaultFile(metaRel, `${JSON.stringify(meta, null, 2)}\n`)
        return parsed.slug
      }
    } catch {
      // Corrupted .marks.json — fall through to fresh.
    }
  }

  // Tier 3 — externally-created file (vim / git) or first scan of a
  // brand-new doc. Mint a slug, persist it. Identity is stable from
  // this scan forwards.
  const slug = generateClientSlug()
  const meta: DocMetaFile = { version: 1, slug }
  await writeVaultFile(metaRel, `${JSON.stringify(meta, null, 2)}\n`)
  return slug
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
 * — skipped silently by the caller). */
function mdRelToKnownDoc(
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
  ]

  // Pass 1: resolve slug for every file. Done up-front because
  // pass-2's writing-note resolution needs the daily slug map.
  const scanned: Array<{ slug: string; mdRel: string }> = []
  for (const mdRel of allMd) {
    const slug = await getOrAssignSlug(mdRel)
    scanned.push({ slug, mdRel })
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
  for (const { slug, mdRel } of scanned) {
    const doc = mdRelToKnownDoc(slug, mdRel, dailySlugByDate)
    if (doc) docs.push(doc)
  }
  return docs
}

// Dev-only console handle. `await __scanVault()` to inspect what the
// boot-time vault scan would currently see.
if (import.meta.env.DEV) {
  ;(window as unknown as { __scanVault: typeof scanVault }).__scanVault = scanVault
}
