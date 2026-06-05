// "Background plumbing": save-detection (dirty) + revision counter. CM gives
// the only signal we need — `update.docChanged` — for free; we just connect it
// to a status the real app would wire to disk auto-flush + the sidebar
// revision dot. (Pairs with CM's built-in placeholder() for the empty-doc hint.)

import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

export interface DocStatus {
  dirty: boolean
  rev: number
}

export const initialStatus: DocStatus = { dirty: false, rev: 0 }

/** A content edit happened → unsaved, revision++. */
export function bumpRevision(s: DocStatus): DocStatus {
  return { dirty: true, rev: s.rev + 1 }
}

/** Flushed to disk → clean (revision unchanged). */
export function markSaved(s: DocStatus): DocStatus {
  return { dirty: false, rev: s.rev }
}

/** Fire `cb(view)` whenever the document content changes (CM's docChanged).
 * The real app routes this to flushDirty + the revision broadcaster. The view
 * is passed so the caller can read the new markdown (doc.toString()) directly —
 * no serializer needed, since the CM doc IS the markdown. */
export function onDocChange(cb: (view: EditorView) => void): Extension {
  return EditorView.updateListener.of((u) => {
    if (u.docChanged) cb(u.view)
  })
}
