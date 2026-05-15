/**
 * Markdown export — one page at a time.
 *
 * Fetches the page's projected markdown and canonical marks from
 * proof-server (both routes live on `/documents/:slug/*`), produces the
 * `(md, sidecar)` pair via `serialize()`, then prompts the user for a
 * save location and writes the two artifacts side-by-side.
 *
 * Why both reads go through proof-server (not the local Y.Doc):
 *   - The exported `.md` should match the canonical projection an
 *     external tool (Obsidian, VS Code) would see — that's what proof-
 *     server emits at `GET /documents/:slug`.
 *   - Marks fetched from `/bridge/marks` are pinned to the same
 *     projection, so quotes line up with the body we just downloaded.
 *   - Going through HTTP makes the flow uniform for closed pages too —
 *     `exportAll` reuses this without needing every doc's Y.Doc handle
 *     to be loaded in the session.
 *
 * Marks with no `quote` or whose `quote` no longer appears in the
 * projected body are dropped silently. Those marks are already
 * orphaned in proof-sdk's model; including them in the sidecar without
 * a valid anchor would just produce broken anchors that a future
 * importer (Level 4) couldn't act on anyway.
 */

import { save } from '@tauri-apps/plugin-dialog'
import { writeTextFile } from '@tauri-apps/plugin-fs'

import { bridgeFetch } from './proofBridge'
import { serialize, type SerializerInput } from './serializer'
import type { MarkKind, MarksSidecarFile } from './types'

const PROOF_BASE_URL = 'http://localhost:4000'

/** Subset of proof-sdk's `Mark` shape we actually read for export. The
 * full type carries kind-specific `data` payloads and orchestration
 * fields we pass through opaquely in `attrs`. */
interface ProofSdkMark {
  id: string
  kind: MarkKind
  by?: string
  at?: string
  quote?: string
  range?: { from: number; to: number }
  orphaned?: boolean
  data?: unknown
  [key: string]: unknown
}

export interface ExportPageResult {
  /** True when the user picked a path and both files were written. */
  ok: boolean
  /** Why we bailed out. Stable strings so callers can surface the
   * right toast copy ('empty' → "nothing to export", 'cancelled' →
   * silent, others → generic error). */
  reason?: 'empty' | 'cancelled' | 'fetch_failed' | 'write_failed'
  /** Resolved `.md` path on success, useful for telemetry / a
   * "reveal in finder" follow-up affordance. */
  filePath?: string
  /** Count of marks the sidecar ended up carrying. Marks with stale
   * quotes are dropped silently and not reflected here. */
  marksExported?: number
}

/**
 * Export a single page by slug. Prompts for save location via the
 * native dialog; writes `<chosen>.md` + `<chosen>.marks.json`.
 *
 * `defaultName` is suggested in the save dialog as the initial
 * filename — falls back to the slug when the caller doesn't have a
 * nicer human-readable label handy.
 */
export async function exportPage(
  slug: string,
  defaultName?: string,
): Promise<ExportPageResult> {
  let text: string
  let marks: ProofSdkMark[]
  try {
    text = await fetchMarkdown(slug)
    marks = await fetchMarks(slug)
  } catch (err) {
    console.warn('[export] fetch failed', slug, err)
    return { ok: false, reason: 'fetch_failed' }
  }

  if (!text) {
    return { ok: false, reason: 'empty' }
  }

  const sidecar = buildSidecar(text, marks)

  const baseName = sanitizeFilename(defaultName || slug)
  let filePath: string | null
  try {
    filePath = await save({
      defaultPath: `${baseName}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
  } catch (err) {
    console.warn('[export] save dialog failed', err)
    return { ok: false, reason: 'write_failed' }
  }

  if (!filePath) return { ok: false, reason: 'cancelled' }

  try {
    await writeTextFile(filePath, text)
    await writeTextFile(sidecarPathFor(filePath), JSON.stringify(sidecar, null, 2))
  } catch (err) {
    console.warn('[export] write failed', filePath, err)
    return { ok: false, reason: 'write_failed' }
  }

  return {
    ok: true,
    filePath,
    marksExported: sidecar.marks.length,
  }
}

/**
 * Build the `.marks.json` payload. Exposed so `exportAll` and any
 * future caller (e.g. a test that wants the bytes without touching
 * disk) can hit the same path the per-page flow uses.
 */
export function buildSidecar(
  text: string,
  marks: ProofSdkMark[],
): MarksSidecarFile {
  const input: SerializerInput = {
    text,
    marks: marks.flatMap((mark) => {
      const quote = mark.quote?.trim()
      if (!quote) return []
      const from = text.indexOf(quote)
      if (from === -1) return []
      return [
        {
          id: mark.id,
          kind: mark.kind,
          attrs: extractAttrs(mark),
          from,
          to: from + quote.length,
        },
      ]
    }),
  }
  return serialize(input).sidecar
}

async function fetchMarkdown(slug: string): Promise<string> {
  const res = await fetch(
    `${PROOF_BASE_URL}/documents/${encodeURIComponent(slug)}`,
  )
  if (!res.ok) throw new Error(`GET /documents/${slug} → ${res.status}`)
  const json = (await res.json()) as { markdown?: string }
  return (json.markdown ?? '').trim()
}

async function fetchMarks(slug: string): Promise<ProofSdkMark[]> {
  const res = await bridgeFetch(slug, '/marks')
  if (!res.ok) throw new Error(`GET /bridge/marks/${slug} → ${res.status}`)
  const json = (await res.json()) as { marks?: ProofSdkMark[] }
  return Array.isArray(json.marks) ? json.marks : []
}

/**
 * Collapse the mark into a flat `attrs` record the sidecar can carry.
 * Anything that's already a primitive stays as-is; nested values
 * (`data` is the common one — comment threads, suggestion content)
 * get JSON-stringified so the importer side can re-parse if it cares.
 *
 * `id`, `kind`, `range`, `quote`, and `orphaned` are handled outside
 * the attrs blob (id/kind become top-level fields; range/quote are
 * recomputed from the live body; orphaned marks are dropped before
 * we reach this point). Skipping them here keeps the sidecar small
 * and avoids storing two copies of the anchor.
 */
function extractAttrs(mark: ProofSdkMark): Record<string, string | null | undefined> {
  const HANDLED = new Set(['id', 'kind', 'range', 'quote', 'orphaned'])
  const attrs: Record<string, string | null | undefined> = {}
  for (const [key, value] of Object.entries(mark)) {
    if (HANDLED.has(key)) continue
    if (value === null || value === undefined) continue
    if (typeof value === 'string') {
      attrs[key] = value
      continue
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      attrs[key] = String(value)
      continue
    }
    try {
      attrs[key] = JSON.stringify(value)
    } catch {
      // Non-serializable (circular, BigInt). Drop silently — we'd
      // rather lose this attr than block the export.
    }
  }
  return attrs
}

/** Strip filesystem-unfriendly characters so a slug like
 * `wiki:custom-7nt...` becomes a clean filename. The save dialog
 * lets the user override this anyway; this is just the initial
 * suggestion. */
function sanitizeFilename(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_').slice(0, 80) || 'page'
}

/** Compute the sidecar path next to the `.md` path the user picked.
 * Replaces a trailing `.md` (case-insensitive), or appends if the user
 * stripped the extension. */
function sidecarPathFor(mdPath: string): string {
  if (/\.md$/i.test(mdPath)) {
    return mdPath.replace(/\.md$/i, '.marks.json')
  }
  return `${mdPath}.marks.json`
}
