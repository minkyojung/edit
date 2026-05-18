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
import type { MarksSidecarFile } from '@/export/types'

/** Read the sidecar's slug, or assign a fresh one if missing. The
 * sidecar is written back so subsequent scans see the same identity.
 * This is what makes vim-created files "adopt" into the app's
 * identity scheme on first encounter. */
async function getOrAssignSlug(mdRel: string): Promise<string> {
  const sidecarRel = mdRel.replace(/\.md$/, '.marks.json')
  if (await vaultFileExists(sidecarRel)) {
    try {
      const raw = await readVaultFile(sidecarRel)
      const parsed = JSON.parse(raw) as Partial<MarksSidecarFile>
      if (typeof parsed.slug === 'string' && parsed.slug.length > 0) {
        return parsed.slug
      }
      // Sidecar exists but lacks a slug field — older sidecars written
      // before Path C step 2. Mint a slug and write it back, preserving
      // any marks already there.
      const slug = generateClientSlug()
      const updated: MarksSidecarFile = {
        version: 1,
        slug,
        marks: Array.isArray(parsed.marks) ? parsed.marks : [],
      }
      await writeVaultFile(sidecarRel, `${JSON.stringify(updated, null, 2)}\n`)
      return slug
    } catch {
      // Corrupted sidecar — treat as missing.
    }
  }
  // No sidecar yet (common for externally-created files). Write a fresh
  // one so the file's identity is durable from this scan onwards.
  const slug = generateClientSlug()
  const sidecar: MarksSidecarFile = { version: 1, slug, marks: [] }
  await writeVaultFile(sidecarRel, `${JSON.stringify(sidecar, null, 2)}\n`)
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
