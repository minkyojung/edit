// Daily-doc body normalization. Strips the legacy "# YYYY-MM-DD"
// heading that an earlier build seeded into the body markdown of
// daily entries (the date label now lives outside the editor and is
// rendered from meta.date).
//
// Phase 5c of the Yjs-removal migration retired the Y.Map-backed
// `titleNormalizedV2` flag this routine used to gate on — `cleanupDailyDateHeading`
// is fully idempotent (it scans for matching legacy h1s and bails on
// the first non-match, so a clean body costs one node-type check),
// and `bodyMarkdown` is the only durable home for the body now.
// Running it on every mount of a daily doc is cheaper than threading
// state through the catalog or `.meta.json`.
//
// Non-daily docs no longer have a structural title slot — whatever
// the user writes in the body is the body, and the displayed label
// is derived from the first non-empty block (see lib/docLabel.ts).
// They run no normalization at all.
//
// Origin: 'doc-init' via the `addToHistory: false` meta + the
// SYSTEM_DOC_INIT_META sentinel so this system-driven cleanup does
// not pollute the user's undo stack (Cmd+Z right after first open
// would otherwise "undo" the migration).

import type { EditorView } from '@milkdown/kit/prose/view'
import { SYSTEM_DOC_INIT_META } from '@/editor/dailyGuardPlugin'

interface NormalizeOptions {
  /** Daily doc's date (YYYY-MM-DD). Used to detect and remove the
   * legacy "# DATE" h1s that earlier builds wrote into the body. */
  date?: string
}

export function normalizeDailyBody(
  view: EditorView,
  options: NormalizeOptions,
): void {
  if (options.date) cleanupDailyDateHeading(view, options.date)
}

// Daily docs: strip any leading h1 whose text is the daily's date
// or a concatenation of repeats of it (legacy artefact from a
// pre-fix multi-bootstrap race). Stops at the first non-matching
// block so a heading the user intentionally wrote is left alone.
function cleanupDailyDateHeading(view: EditorView, date: string): void {
  const doc = view.state.doc
  let pos = 0
  let endRemovePos = 0
  for (let i = 0; i < doc.childCount; i += 1) {
    const child = doc.child(i)
    if (child.type.name !== 'heading') break
    if (child.attrs.level !== 1) break
    if (!isRepeatedDate(child.textContent, date)) break
    endRemovePos = pos + child.nodeSize
    pos += child.nodeSize
  }
  if (endRemovePos === 0) return
  const tr = view.state.tr.delete(0, endRemovePos)
  tr.setMeta('addToHistory', false)
  tr.setMeta(SYSTEM_DOC_INIT_META, true)
  view.dispatch(tr)
}

function isRepeatedDate(text: string, date: string): boolean {
  if (text.length === 0 || date.length === 0) return false
  if (text.length % date.length !== 0) return false
  const repeats = text.length / date.length
  for (let i = 0; i < repeats; i += 1) {
    if (text.slice(i * date.length, (i + 1) * date.length) !== date) return false
  }
  return true
}
