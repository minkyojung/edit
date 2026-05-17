// Doc ↔ vault file synchronisation.
//
// Phase 4.B turns this layer into the bridge between the live Y.Doc
// (memory + IDB today, becoming memory + file in 4.B.1) and the
// markdown + sidecar pair on disk. The runtime flow grows in stages:
//
//   4.B.1.b.i  (this commit) — serializeDocToFiles for the simple
//                              case: active doc, no marks. Pure read;
//                              no disk I/O, no observer install.
//   4.B.1.b.ii — add mark anchor extraction (PM position → char
//                offset in the serialised markdown).
//   4.B.1.b.iii — handle inactive docs (fragment fallback or
//                 transient PM reconstruction).
//   4.B.1.b.iv — install observer + debounced atomic write on
//                Y.Doc changes.
//
// Splitting this way lets each step be inspected in DevTools before
// the next layer goes in: serialize once, see the output, decide
// whether the markdown / sidecar shape is right before wiring
// auto-save on top.

import { useDocsStore } from '@/state/docsStore'
import { useEditorViewStore } from '@/state/editorViewStore'
import type { MarksSidecarFile } from '@/export/types'

/** Result shape of {@link serializeDocToFiles} — the two strings we
 * would write side-by-side to disk (body + sidecar). Mirrors
 * `SerializedDoc` from `export/types.ts` so the data flows straight
 * into the file-write step once that's wired. */
export interface SerializedDocFiles {
  md: string
  sidecar: MarksSidecarFile
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

  // Sidecar marks left empty in this step — see file header for the
  // sub-phase plan; the resolver + adapter exist, the wiring lands
  // in 4.B.1.b.ii.
  const sidecar: MarksSidecarFile = {
    version: 1,
    marks: [],
  }

  return { md, sidecar }
}

// Dev-only console handle. Pass a slug, or omit to use the active
// doc. Returns null when no doc is active or the serializer isn't
// ready yet.
//   __serializeDoc()              // current active doc
//   __serializeDoc('wiki:custom-abc')
if (import.meta.env.DEV) {
  const handle = (slug?: string): SerializedDocFiles | null => {
    const target = slug ?? useDocsStore.getState().activeSlug
    if (!target) return null
    return serializeDocToFiles(target)
  }
  ;(window as unknown as { __serializeDoc: typeof handle }).__serializeDoc = handle
}
