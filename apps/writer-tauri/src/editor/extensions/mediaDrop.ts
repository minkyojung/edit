// Media drag-drop + clipboard-paste (migration). Drop a media file from
// Finder, or paste a screenshot → import into the vault and insert the matching
// card markdown at the drop point. CM-native: domEventHandlers(drop, paste) +
// the existing vault importers + plain text insertion (our media/image cards
// render the inserted markdown). The async import runs outside the dispatch,
// one insert per file — same shape as the PM mediaDropPastePlugin, minus the
// schema-node machinery.

import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { dropAnchorField, addDropAnchor, clearDropAnchor } from './dropAnchor'

export type MediaKind = 'image' | 'video' | 'audio'

/** Classify by MIME prefix (the PM plugin's classifyMediaFile). */
export function classifyMedia(file: { type: string }): MediaKind | null {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  return null
}

/** The card markdown for an imported file — matches what livePreview /
 * mediaCards detect (`![..](..)`, `<video>`, `<audio>`). The image URL is
 * percent-encoded: markdown `![](url)` (and our Image regex) forbid spaces, so a
 * filename like `Screenshot 2026.png` must ride as `Screenshot%202026.png` or it
 * won't parse as an image. (`<video>`/`<audio>` srcs sit in quoted HTML attributes,
 * where spaces are legal, so they stay raw.) resolveVaultAssetSrc decodes on the way
 * back to the file. */
export function markdownForMedia(kind: MediaKind, url: string, name: string): string {
  if (kind === 'image') return `![${name}](${encodeURI(url)})`
  if (kind === 'video') return `<video src="${url}" controls></video>`
  return `<audio src="${url}" title="${name}" controls></audio>`
}

/** drop/paste → import each media file → insert its card markdown on its own
 * line near the drop point. `importFile` is the vault copy (real app); the
 * prototype passes an object-URL stub. */
export function mediaDropPaste(importFile: (file: File) => Promise<string>): Extension {
  let nextAnchorId = 0 // per-editor (this factory runs once per mount) — no module state
  function insertAt(view: EditorView, basePos: number, file: File, kind: MediaKind) {
    // Register the drop point so it MAPS through any edits made while the import runs
    // (typing above it, an AI rewrite) instead of landing at a stale offset.
    const id = nextAnchorId++
    view.dispatch({ effects: addDropAnchor.of({ id, pos: basePos }) })
    void importFile(file).then((url) => {
      const anchor = view.state.field(dropAnchorField, false)?.get(id)
      if (anchor === undefined) return // anchor cleared / field gone
      const md = markdownForMedia(kind, url, file.name)
      const line = view.state.doc.lineAt(Math.min(anchor, view.state.doc.length))
      const at = line.to
      try {
        view.dispatch({
          changes: { from: at, insert: `\n\n${md}` },
          selection: { anchor: at + 2 + md.length },
          effects: clearDropAnchor.of(id),
        })
      } catch {
        // The view was torn down between the drop and the import resolving (a doc
        // switch). The file is in the vault but its reference isn't inserted — a known
        // orphan; wiring a docsStore-body fallback for the unmounted case is a separate
        // follow-up.
      }
    })
  }

  function handle(view: EditorView, files: FileList, basePos: number): boolean {
    let any = false
    for (const file of Array.from(files)) {
      const kind = classifyMedia(file)
      if (!kind) continue
      any = true
      insertAt(view, basePos, file, kind)
    }
    return any
  }

  return [dropAnchorField, EditorView.domEventHandlers({
    // Browsers only fire `drop` if `dragover` was preventDefault'd for the
    // dragged data. Without this, a file drop is rejected (no drop event).
    dragover(event) {
      if (event.dataTransfer?.types?.includes('Files')) {
        event.preventDefault()
        return true
      }
      return false
    },
    drop(event, view) {
      const files = event.dataTransfer?.files
      if (!files || files.length === 0) return false
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head
      if (!handle(view, files, pos)) return false
      event.preventDefault()
      return true
    },
    paste(event, view) {
      const files = event.clipboardData?.files
      if (!files || files.length === 0) return false
      if (!handle(view, files, view.state.selection.main.head)) return false
      event.preventDefault()
      return true
    },
  })]
}
