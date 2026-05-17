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
  return () => {
    fragment.unobserveDeep(onChange)
    marksMap.unobserve(onChange)
    dirtySlugs.delete(slug)
  }
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
}
