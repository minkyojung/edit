/**
 * Markdown export — one page at a time.
 *
 * Two read paths, in priority order:
 *   1. Local — when the page is the active doc, read the body from
 *      the live PM editor view (via Milkdown's serializer) and the
 *      marks from the local `Y.Map('marks')`. This is the only
 *      reliable source for writing/daily-type docs because their
 *      server-side markdown projection is debounced and was observed
 *      empty in practice on docs whose projection had never been
 *      populated by a prior write event.
 *   2. HTTP — fallback for slugs that aren't currently open. Uses
 *      `GET /documents/:slug` for the body and the bridge `/marks`
 *      route for marks. `exportAll` (whole-wiki dump) relies on this
 *      path since most pages are closed.
 *
 * The two paths feed the same `buildSidecar` so the on-disk shape is
 * identical regardless of which source we read from.
 *
 * Marks with no `quote` or whose `quote` doesn't appear in the body
 * we just produced are dropped silently. Those marks have lost their
 * anchor and would just produce broken entries in the sidecar.
 */

import { save } from '@tauri-apps/plugin-dialog'
import { writeTextFile } from '@tauri-apps/plugin-fs'
import type { EditorView } from '@milkdown/kit/prose/view'
import type * as Y from 'yjs'

import { useEditorViewStore } from '@/state/editorViewStore'
import type { StoredMark } from '@/hooks/useCollabDoc'

import { bridgeFetch } from './proofBridge'
import { serialize, type SerializerInput } from './serializer'
import type { MarkKind, MarksSidecarFile } from './types'

const PROOF_BASE_URL = 'http://localhost:4000'

/** Subset of proof-sdk's `Mark` shape we read off the bridge. The
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
  /** Count of marks the sidecar ended up carrying. Marks dropped for
   * a missing/stale quote aren't reflected here. */
  marksExported?: number
}

export interface ExportPageOptions {
  /** Suggested filename for the save dialog (falls back to slug). */
  defaultName?: string
  /** When provided, the local read path is used: body is taken from
   * the editor view via Milkdown's serializer, marks from `ydoc`'s
   * `Y.Map('marks')`. Both must be present together; passing only
   * one falls back to HTTP. */
  editorView?: EditorView | null
  ydoc?: Y.Doc | null
}

/**
 * Export a single page by slug. Prefers the local editor state when
 * available (active doc), falls back to HTTP for anything else.
 */
export async function exportPage(
  slug: string,
  options: ExportPageOptions = {},
): Promise<ExportPageResult> {
  const { defaultName, editorView, ydoc } = options

  let text: string
  let sidecar: MarksSidecarFile
  try {
    if (editorView && ydoc) {
      const local = readLocal(editorView, ydoc)
      text = local.text
      sidecar = buildSidecarFromLocal(local.text, local.marks)
    } else {
      const remoteText = await fetchMarkdown(slug)
      const remoteMarks = await fetchMarks(slug)
      text = remoteText
      sidecar = buildSidecar(remoteText, remoteMarks)
    }
  } catch (err) {
    console.warn('[export] read failed', slug, err)
    return { ok: false, reason: 'fetch_failed' }
  }

  if (!text || !text.trim()) {
    return { ok: false, reason: 'empty' }
  }

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
 * Build the `.marks.json` payload from a proof-server bridge response.
 * Exposed so `exportAll` and any future caller (e.g. a test that
 * wants the bytes without touching disk) can hit the same path the
 * per-page HTTP flow uses.
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
          attrs: extractRemoteAttrs(mark),
          from,
          to: from + quote.length,
        },
      ]
    }),
  }
  return serialize(input).sidecar
}

/**
 * Build the sidecar from the local `Y.Map<StoredMark>('marks')`
 * entries. Mirrors `buildSidecar` but reads writer-tauri's richer
 * `StoredMark` shape (carries provenance fields like sourceSlug,
 * model, acceptedAt that the public bridge response doesn't surface).
 */
function buildSidecarFromLocal(
  text: string,
  marks: Array<{ id: string; stored: StoredMark }>,
): MarksSidecarFile {
  const input: SerializerInput = {
    text,
    marks: marks.flatMap(({ id, stored }) => {
      const quote = stored.quote?.trim()
      if (!quote) return []
      const from = text.indexOf(quote)
      if (from === -1) return []
      const kind = normalizeKind(stored.kind)
      if (!kind) return []
      return [
        {
          id: stored.id ?? id,
          kind,
          attrs: extractLocalAttrs(stored),
          from,
          to: from + quote.length,
        },
      ]
    }),
  }
  return serialize(input).sidecar
}

/**
 * Read the active doc's markdown body + marks from local memory.
 * Throws if Milkdown's serializer hasn't registered yet (rare — the
 * editor mount path sets it before the user could plausibly click an
 * export menu item, but covered explicitly so a hypothetical race
 * surfaces as a clean error instead of an opaque empty export).
 */
function readLocal(
  view: EditorView,
  ydoc: Y.Doc,
): { text: string; marks: Array<{ id: string; stored: StoredMark }> } {
  const serializer = useEditorViewStore.getState().serializer
  if (!serializer) {
    throw new Error('serializer_not_ready')
  }
  const text = serializer(view.state.doc)
  const marks: Array<{ id: string; stored: StoredMark }> = []
  ydoc.getMap<StoredMark>('marks').forEach((stored, id) => {
    if (stored) marks.push({ id, stored })
  })
  return { text, marks }
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
 * Collapse a proof-sdk Mark response into a flat `attrs` record. See
 * `extractLocalAttrs` for the StoredMark-shaped version. Both omit
 * `id`/`kind`/`range`/`quote`/`orphaned` because those are handled
 * outside the attrs blob.
 */
function extractRemoteAttrs(mark: ProofSdkMark): Record<string, string | null | undefined> {
  return flattenForAttrs(mark, REMOTE_HANDLED)
}

function extractLocalAttrs(stored: StoredMark): Record<string, string | null | undefined> {
  return flattenForAttrs(stored as unknown as Record<string, unknown>, LOCAL_HANDLED)
}

const REMOTE_HANDLED: ReadonlySet<string> = new Set([
  'id',
  'kind',
  'range',
  'quote',
  'orphaned',
])

const LOCAL_HANDLED: ReadonlySet<string> = new Set([
  'id',
  'kind',
  'range',
  'quote',
  'startRel',
  'endRel',
  'orphaned',
])

function flattenForAttrs(
  obj: Record<string, unknown>,
  skip: ReadonlySet<string>,
): Record<string, string | null | undefined> {
  const attrs: Record<string, string | null | undefined> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (skip.has(key)) continue
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

/** `StoredMark.kind` is broader than `MarkKind` (older drafts carry
 * deprecated values). Anything we don't recognize is dropped from
 * the export — the sidecar's MarkKind union is the contract a future
 * importer reads against. */
function normalizeKind(kind: string | undefined): MarkKind | null {
  const known: ReadonlySet<MarkKind> = new Set([
    'authored',
    'approved',
    'flagged',
    'comment',
    'insert',
    'delete',
    'replace',
    'provenance',
  ])
  if (kind && known.has(kind as MarkKind)) return kind as MarkKind
  return null
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
