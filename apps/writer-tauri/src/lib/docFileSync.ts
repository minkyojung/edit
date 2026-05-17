// Doc ↔ vault file synchronisation.
//
// Phase 4.B turns this layer into the bridge between the live Y.Doc
// (memory + IDB today, becoming memory + file in 4.B.1) and the
// markdown + sidecar pair on disk. The runtime flow grows in stages:
//
//   4.B.1.b.i   — serializeDocToFiles for the simple case: active
//                 doc, no marks. Pure read; no disk I/O.
//   4.B.1.b.ii (this commit) — populate the sidecar by extracting
//                 marks from markStore and computing semantic anchors
//                 (quote + context + occurrence) against the serialised
//                 markdown. Mirrors the markResolver fallback chain so
//                 saves and loads stay symmetric.
//   4.B.1.b.iii — handle inactive docs (fragment fallback or
//                 transient PM reconstruction).
//   4.B.1.b.iv  — install observer + debounced atomic write on
//                 Y.Doc changes.
//
// Splitting this way lets each step be inspected in DevTools before
// the next layer goes in: serialize once, see the output, decide
// whether the markdown / sidecar shape is right before wiring
// auto-save on top.

import type * as Y from 'yjs'
import { useDocsStore } from '@/state/docsStore'
import { useEditorViewStore } from '@/state/editorViewStore'
import { markStore } from '@/domain/markStoreInstance'
import type { Mark } from '@/domain/marks'
import { markToSidecar } from '@/export/markAdapter'
import type { AnchorSpec, MarkSidecar, MarksSidecarFile } from '@/export/types'
import { pathForDoc, sidecarPathForDoc } from '@/lib/docPaths'
import { readVaultFile, vaultFileExists, writeVaultFile } from '@/lib/vault'
import { getActiveVaultPath } from '@/state/settingsStore'

/** Result shape of {@link serializeDocToFiles} — the two strings we
 * would write side-by-side to disk (body + sidecar). Mirrors
 * `SerializedDoc` from `export/types.ts` so the data flows straight
 * into the file-write step once that's wired. */
export interface SerializedDocFiles {
  md: string
  sidecar: MarksSidecarFile
}

const CONTEXT_WINDOW = 32

/** Build the semantic anchor for one mark by re-locating its quote
 * inside the serialised markdown. Mirrors prototype-git-storage's
 * resolver so save / load stay symmetric: a sidecar produced here
 * can be re-anchored by markResolver without translation.
 *
 * Strategy
 *   - First occurrence wins (occurrence=0). Same-quote duplicates on
 *     the same page are disambiguated on load via contextBefore /
 *     contextAfter + the recorded occurrence ordinal.
 *   - Returns null when the quote isn't in the body — caller drops
 *     that mark from the sidecar rather than persisting a broken
 *     anchor that would only flag as orphan on every load.
 *
 * v1 limitation: a mark whose quote appears N > 1 times on the page
 * always serialises with occurrence=0. The wrapping flow (next
 * step) will look at the mark's PM range to pick the right
 * occurrence; for the simple sidecar build here it's the first
 * match. */
function buildAnchorForMark(text: string, mark: Mark): AnchorSpec | null {
  if (!mark.quote) return null
  const idx = text.indexOf(mark.quote)
  if (idx === -1) return null
  return {
    quote: mark.quote,
    contextBefore: text.slice(Math.max(0, idx - CONTEXT_WINDOW), idx),
    contextAfter: text.slice(
      idx + mark.quote.length,
      Math.min(text.length, idx + mark.quote.length + CONTEXT_WINDOW),
    ),
    occurrence: 0,
  }
}

/** Pull marks out of markStore and convert them to sidecar entries.
 * Marks that can't be re-anchored against the current body
 * (`buildAnchorForMark` returns null) drop out — they'd be flagged
 * as `orphaned` on load anyway, and quietly skipping them now
 * keeps the sidecar honest about what's on this page right now. */
function buildSidecarMarks(slug: string, md: string): MarkSidecar[] {
  const marks = markStore.list(slug)
  const out: MarkSidecar[] = []
  for (const mark of marks) {
    const anchor = buildAnchorForMark(md, mark)
    if (!anchor) continue
    out.push(markToSidecar(mark, anchor))
  }
  return out
}

/** Serialize one open doc to the on-disk pair `{md, sidecar}`.
 *
 * v1 scope: only the active doc, marks ignored (sidecar is empty).
 * Returns null when the doc isn't open, the view hasn't mounted,
 * or the Milkdown serializer isn't ready yet — callers should
 * treat that as "skip this tick, try again next change" rather
 * than an error.
 *
 * The markdown output is whatever Milkdown's commonmark + gfm
 * serializer produces for the live PM doc. Mark spans currently
 * survive in the output as inline HTML (per `proof-marks.ts`'s
 * toMarkdown runner) — that's fine for this step because we're
 * verifying the body shape, not yet the mark strip. The next step
 * (4.B.1.b.ii) will move mark metadata into the sidecar and produce
 * clean markdown without span clutter. */
export function serializeDocToFiles(slug: string): SerializedDocFiles | null {
  const docs = useDocsStore.getState()
  const handle = docs.handles[slug]
  if (!handle) return null

  // Active-doc happy path: the live PM view + serializer give the
  // most accurate body (markdown is regenerated from the doc the
  // user can actually see). Inactive handles fall through to null
  // until 4.B.1.b.iii lands a fragment-based fallback.
  const isActive = docs.activeSlug === slug
  if (!isActive) return null

  const { view, serializer } = useEditorViewStore.getState()
  if (!view || !serializer) return null

  let md: string
  try {
    md = serializer(view.state.doc)
  } catch (err) {
    console.warn('[docFileSync] serializer failed for slug', slug, err)
    return null
  }

  const sidecar: MarksSidecarFile = {
    version: 1,
    marks: buildSidecarMarks(slug, md),
  }

  return { md, sidecar }
}

// ── Dirty tracking ───────────────────────────────────────────────
//
// Each open doc's Y.Doc gets an observer that marks the slug "dirty"
// on any content or mark mutation. A future auto-flush tick (Phase
// 4.B.1.b.iv.2-3) walks `dirtySlugs` periodically and writes the
// changed docs to vault files.
//
// This sub-phase (iv.1) installs only the observers and the set —
// no disk I/O yet, so we can verify the dirty signal in DevTools
// before wiring the actual flush.

const dirtySlugs = new Set<string>()

function markDirty(slug: string): void {
  dirtySlugs.add(slug)
}

/** Mark `slug` clean — called by the flush tick after a successful
 * write. Exposed for tests and the future flushDirty implementation
 * (iv.3). */
export function clearDirty(slug: string): void {
  dirtySlugs.delete(slug)
}

/** Snapshot of slugs that have unsaved changes since their last
 * successful flush. Returns a copy so callers can iterate while the
 * underlying set mutates from background observers. */
export function getDirtySlugs(): string[] {
  return [...dirtySlugs]
}

/** Wire up the dirty tracker for a handle. Returns a disposer that
 * removes observers and clears the slug from `dirtySlugs` — closeDoc
 * should call it so a torn-down handle's leftover dirty flag doesn't
 * trigger a flush against a destroyed ydoc.
 *
 * Observes both the body fragment (text edits, paste, ingest insert)
 * and the marks map (suggestion add / accept / reject); either kind
 * of change should produce a save. */
export function installDocSync(slug: string, ydoc: Y.Doc): () => void {
  const fragment = ydoc.getXmlFragment('prosemirror')
  const marksMap = ydoc.getMap('marks')
  const onChange = () => markDirty(slug)
  fragment.observeDeep(onChange)
  marksMap.observe(onChange)
  // Mark dirty on install so the first flush tick mirrors this doc
  // to disk regardless of whether the user edits it. Without this,
  // a doc the user opens (or that was already open at boot) but
  // never types into would never reach the vault — leaving gaps
  // between what the sidebar shows and what's on disk. Idempotent
  // — clearDirty after the flush completes leaves the doc clean
  // until the next edit. The cost is one write per doc-mount event;
  // overwrite is benign even when the file already matches.
  markDirty(slug)
  return () => {
    fragment.unobserveDeep(onChange)
    marksMap.unobserve(onChange)
    dirtySlugs.delete(slug)
  }
}

// ── Auto-flush timer ─────────────────────────────────────────────
//
// Obsidian-style periodic flush: every FLUSH_INTERVAL_MS the timer
// checks `dirtySlugs` and (in a later sub-phase) writes the changed
// docs to the vault. This module owns the timer lifecycle so the
// rest of the app sees a simple start/stop API.
//
// In this sub-phase (iv.2) the timer body is a dummy console log —
// we want to verify the cadence first, then replace the callback
// with the real serialize-and-write pipeline in iv.3.
//
// The 2000ms interval matches what Obsidian observes in practice
// (~2s periodic flush during continuous typing, per its plugin
// surface). It's the "natural feel" point — short enough that
// power loss won't lose more than a couple of seconds of typing,
// long enough that a fast typist doesn't trigger constant disk
// I/O.

const FLUSH_INTERVAL_MS = 2000
let flushTimerId: number | null = null

/** Read a doc's vault files (`.md` + `.marks.json`) from disk and
 * return them as raw data. Inverse of {@link serializeDocToFiles}
 * — at the data layer, before any Y.Doc / markStore mutation.
 *
 * Returns null when there's no `.md` for this doc — caller treats
 * that as "no on-disk copy yet, fall back to whatever the in-memory
 * source provides" (currently IDB; eventually a fresh empty doc).
 *
 * Sidecar handling:
 *   - missing `.marks.json`  → returns `{md, sidecar: {version: 1, marks: []}}`
 *     (a vault that was edited only by an external markdown-aware
 *     tool wouldn't have our sidecar; this is the graceful path)
 *   - malformed JSON         → same as missing, but logged once
 *   - unsupported version    → same; sidecar evolution will add
 *     a migrate hook here
 *
 * The function is pure read — no Y.Doc, no markStore. Wiring into
 * the doc lifecycle is the next sub-step (4.B.1.c.ii+). */
export async function loadDocFromFiles(
  slug: string,
): Promise<SerializedDocFiles | null> {
  if (!getActiveVaultPath()) return null
  const docs = useDocsStore.getState()
  const known = docs.knownDocs.find((d) => d.slug === slug)
  if (!known) return null
  const mdPath = pathForDoc(known)
  const sidecarPath = sidecarPathForDoc(known)
  if (!mdPath || !sidecarPath) return null

  if (!(await vaultFileExists(mdPath))) return null
  let md: string
  try {
    md = await readVaultFile(mdPath)
  } catch (err) {
    console.warn('[vault:load] read md failed for', slug, err)
    return null
  }

  let sidecar: MarksSidecarFile = { version: 1, marks: [] }
  if (await vaultFileExists(sidecarPath)) {
    try {
      const raw = await readVaultFile(sidecarPath)
      const parsed = JSON.parse(raw) as unknown
      if (isSidecarFile(parsed)) {
        sidecar = parsed
      } else {
        console.warn('[vault:load] sidecar shape unrecognised, ignoring', slug)
      }
    } catch (err) {
      console.warn('[vault:load] sidecar parse failed for', slug, err)
    }
  }

  return { md, sidecar }
}

/** Narrow a JSON.parse result to MarksSidecarFile. Defensive — the
 * file on disk could have been hand-edited or written by an older /
 * future version of the app. */
function isSidecarFile(value: unknown): value is MarksSidecarFile {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<MarksSidecarFile>
  return v.version === 1 && Array.isArray(v.marks)
}

/** Walk dirty slugs once and persist each to its vault file pair.
 * Called from the periodic flush timer. Errors are isolated per
 * slug — a single failed write doesn't block the others — and the
 * slug stays dirty so the next tick retries.
 *
 * Skip conditions (all silent — leave dirty for next tick or clear
 * outright depending on whether the cause is transient):
 *   - vault not selected           → skip all (transient)
 *   - slug no longer in knownDocs  → clear (no point retrying)
 *   - pathForDoc returns null      → clear (doc type has no on-disk
 *                                    placement — e.g. 'writing')
 *   - serializeDocToFiles null     → skip (active not ready,
 *                                    transient — wait for view) */
export async function flushDirty(): Promise<void> {
  if (!getActiveVaultPath()) return
  const docs = useDocsStore.getState()
  for (const slug of getDirtySlugs()) {
    const known = docs.knownDocs.find((d) => d.slug === slug)
    if (!known) {
      clearDirty(slug)
      continue
    }
    const mdPath = pathForDoc(known)
    const sidecarPath = sidecarPathForDoc(known)
    if (!mdPath || !sidecarPath) {
      clearDirty(slug)
      continue
    }
    const result = serializeDocToFiles(slug)
    if (!result) continue
    try {
      await writeVaultFile(mdPath, result.md)
      await writeVaultFile(sidecarPath, JSON.stringify(result.sidecar, null, 2))
      clearDirty(slug)
    } catch (err) {
      console.warn('[vault:flush] write failed for', slug, err)
      // Leave dirty so the next tick retries.
    }
  }
}

/** Begin the periodic flush loop. Idempotent — calling twice is a
 * no-op so multiple boot paths can call it without coordination. */
export function startAutoFlush(): void {
  if (flushTimerId !== null) return
  flushTimerId = window.setInterval(() => {
    void flushDirty()
  }, FLUSH_INTERVAL_MS)
}

/** Stop the periodic flush loop. Idempotent. Called on app teardown
 * (Tauri ExitRequested) so the timer doesn't leak into a closing
 * window. iv.4 will also drive a final synchronous flush from this
 * path so unsaved dirty slugs land on disk before exit. */
export function stopAutoFlush(): void {
  if (flushTimerId === null) return
  window.clearInterval(flushTimerId)
  flushTimerId = null
}

// Dev-only console handle. Pass a slug, or omit to use the active
// doc. Returns null when no doc is active or the serializer isn't
// ready yet.
//   __serializeDoc()              // current active doc
//   __serializeDoc('wiki:custom-abc')
//   __listMarks()                  // mark store state of active doc
if (import.meta.env.DEV) {
  const handle = (slug?: string): SerializedDocFiles | null => {
    const target = slug ?? useDocsStore.getState().activeSlug
    if (!target) return null
    return serializeDocToFiles(target)
  }
  const listMarks = (slug?: string): Mark[] => {
    const target = slug ?? useDocsStore.getState().activeSlug
    if (!target) return []
    return markStore.list(target)
  }
  ;(window as unknown as {
    __serializeDoc: typeof handle
    __listMarks: typeof listMarks
  }).__serializeDoc = handle
  ;(window as unknown as { __listMarks: typeof listMarks }).__listMarks = listMarks
  ;(window as unknown as { __dirtySlugs: () => string[] }).__dirtySlugs = getDirtySlugs
  const loadHandle = async (slug?: string): Promise<SerializedDocFiles | null> => {
    const target = slug ?? useDocsStore.getState().activeSlug
    if (!target) return null
    return loadDocFromFiles(target)
  }
  ;(window as unknown as { __loadDoc: typeof loadHandle }).__loadDoc = loadHandle
}
