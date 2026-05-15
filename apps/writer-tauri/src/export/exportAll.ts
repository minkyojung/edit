/**
 * Markdown export — whole-wiki dump into a user-chosen folder.
 *
 * Asks the user for a destination directory, then iterates every
 * non-archived wiki content page (`wiki:custom-*`) and writes its
 * `.md` + `.marks.json` pair inside. The per-page logic is shared
 * with `exportPage` via `buildSidecar` so the two surfaces never
 * drift on what they consider a mark.
 *
 * Scope decision (v1 — refine after telemetry):
 *   - Includes  : user-owned wiki content (`isUserOwnedWiki`)
 *   - Excludes  : daily entries, writing notes, system pages,
 *                 archived docs
 *
 * The "user-owned wiki" filter matches what the rest of the app
 * treats as portable content. Daily/writing entries are user-private
 * scratch; system pages are agent-managed metadata. Including them
 * in a "your wiki, exported" zip would surprise the user.
 */

import { open } from '@tauri-apps/plugin-dialog'
import { writeTextFile, mkdir } from '@tauri-apps/plugin-fs'

import {
  useDocsStore,
  isUserOwnedWiki,
  type KnownDoc,
} from '@/state/docsStore'

import { buildSidecar } from './exportPage'
import { bridgeFetch } from './proofBridge'

const PROOF_BASE_URL = 'http://localhost:4000'

export interface ExportAllResult {
  ok: boolean
  reason?: 'cancelled' | 'no_pages' | 'fetch_failed' | 'write_failed'
  /** Resolved root directory the export was written into. */
  rootPath?: string
  /** Number of pages successfully written. May be less than the
   * eligible-pages count when some pages failed to fetch — failures
   * are logged to console and the rest of the export continues. */
  pagesExported?: number
  /** Pages that hit a fetch / write error and were skipped. Helpful
   * for surfacing "exported 12/13" toast copy. */
  failedSlugs?: string[]
}

/**
 * Export every user-owned wiki page into a single directory.
 *
 * Layout written to disk:
 *
 *     <chosenDir>/
 *     └── pages/
 *         ├── <slug or title>.md
 *         └── <slug or title>.marks.json
 *
 * The `pages/` subdirectory keeps the root tidy — leaves room for a
 * future Level 4 layout that also writes `.proposals/`, `.conf`, etc.
 * without colliding with the body files.
 */
export async function exportAll(): Promise<ExportAllResult> {
  let dir: string | string[] | null
  try {
    dir = await open({ directory: true, multiple: false })
  } catch (err) {
    console.warn('[export] folder dialog failed', err)
    return { ok: false, reason: 'write_failed' }
  }
  if (!dir || Array.isArray(dir)) return { ok: false, reason: 'cancelled' }
  const rootPath = dir

  const pages = collectExportablePages()
  if (pages.length === 0) return { ok: false, reason: 'no_pages' }

  const pagesDir = `${rootPath}/pages`
  try {
    await mkdir(pagesDir, { recursive: true })
  } catch (err) {
    console.warn('[export] mkdir failed', pagesDir, err)
    return { ok: false, reason: 'write_failed' }
  }

  const failedSlugs: string[] = []
  const seenNames = new Set<string>()
  let pagesExported = 0

  for (const page of pages) {
    try {
      const text = await fetchMarkdown(page.slug)
      if (!text) {
        // Empty page — skip silently. We could write an empty `.md`
        // but doing so would clutter the export with files that have
        // no content for the user to inspect.
        continue
      }
      const marks = await fetchMarks(page.slug)
      const sidecar = buildSidecar(text, marks)

      const fileBase = uniqueFilename(
        sanitizeFilename(page.title || page.slug),
        seenNames,
      )
      seenNames.add(fileBase)
      const mdPath = `${pagesDir}/${fileBase}.md`
      const sidecarPath = `${pagesDir}/${fileBase}.marks.json`

      await writeTextFile(mdPath, text)
      await writeTextFile(sidecarPath, JSON.stringify(sidecar, null, 2))
      pagesExported += 1
    } catch (err) {
      console.warn('[export] page failed', page.slug, err)
      failedSlugs.push(page.slug)
    }
  }

  if (pagesExported === 0 && failedSlugs.length > 0) {
    return { ok: false, reason: 'fetch_failed', rootPath, failedSlugs }
  }

  return {
    ok: true,
    rootPath,
    pagesExported,
    failedSlugs: failedSlugs.length > 0 ? failedSlugs : undefined,
  }
}

function collectExportablePages(): Array<Pick<KnownDoc, 'slug' | 'title'>> {
  return useDocsStore
    .getState()
    .knownDocs.filter((d) => isUserOwnedWiki(d) && !d.archivedAt)
    .map((d) => ({ slug: d.slug, title: d.title }))
}

async function fetchMarkdown(slug: string): Promise<string> {
  const res = await fetch(
    `${PROOF_BASE_URL}/documents/${encodeURIComponent(slug)}`,
  )
  if (!res.ok) throw new Error(`GET /documents/${slug} → ${res.status}`)
  const json = (await res.json()) as { markdown?: string }
  return (json.markdown ?? '').trim()
}

async function fetchMarks(
  slug: string,
): Promise<Parameters<typeof buildSidecar>[1]> {
  const res = await bridgeFetch(slug, '/marks')
  if (!res.ok) throw new Error(`GET /bridge/marks/${slug} → ${res.status}`)
  const json = (await res.json()) as {
    marks?: Parameters<typeof buildSidecar>[1]
  }
  return Array.isArray(json.marks) ? json.marks : []
}

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_').trim().slice(0, 80) || 'page'
}

/**
 * Guard against two pages collapsing to the same filename after
 * sanitization (e.g. titles "Foo/Bar" and "Foo_Bar" both becoming
 * "Foo_Bar"). Appends a numeric suffix until the name is free —
 * `Foo_Bar`, then `Foo_Bar-2`, etc.
 */
function uniqueFilename(base: string, seen: ReadonlySet<string>): string {
  if (!seen.has(base)) return base
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`
    if (!seen.has(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}
