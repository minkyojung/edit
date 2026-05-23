// Drag-and-drop + clipboard-paste handler for media files (images
// and videos).
//
// The slash menu covers explicit insertion via file dialog; this
// plugin handles the two other paths every note-app user expects:
//   - Drag a media file from Finder → drop into the editor.
//   - Take a screenshot (Cmd+Shift+4 on macOS) → Cmd+V into the
//     editor. The screenshot arrives as a PNG `File` on the
//     clipboard with no source path.
//
// Each file is classified by MIME prefix into image vs video and
// routed to the matching importer (`importImageFile` /
// `importVideoFile`) and node type (`imageBlock` / `videoBlock`).
// Both branches converge on `insertBlockAtSelection`, which is
// generic over block atoms.
//
// The async copy-into-vault step runs *outside* the transaction.
// We move the selection to the drop position first, then dispatch
// one transaction per file as each `arrayBuffer()` resolves. This
// keeps each insert atomic from PM's perspective.

import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { insertBlockAtSelection } from './insertBlock'
import { importImageFile } from '@/lib/vaultImages'
import { importVideoFile } from '@/lib/vaultVideos'
import { flushDirty } from '@/lib/docFileSync'

type MediaKind = 'image' | 'video'

function classifyMediaFile(file: File): MediaKind | null {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  return null
}

function filterMediaFiles(
  list: FileList | null | undefined,
): Array<{ file: File; kind: MediaKind }> {
  if (!list) return []
  const out: Array<{ file: File; kind: MediaKind }> = []
  for (const file of Array.from(list)) {
    const kind = classifyMediaFile(file)
    if (kind) out.push({ file, kind })
  }
  return out
}

async function insertMediaAtSelection(
  view: EditorView,
  files: Array<{ file: File; kind: MediaKind }>,
): Promise<void> {
  for (const { file, kind } of files) {
    try {
      const relPath =
        kind === 'image'
          ? await importImageFile(file)
          : await importVideoFile(file)
      const nodeName = kind === 'image' ? 'imageBlock' : 'videoBlock'
      const t = view.state.schema.nodes[nodeName]
      if (!t) continue
      const attrs =
        kind === 'image'
          ? { src: relPath, alt: file.name.replace(/\.[^.]+$/, ''), title: '' }
          : { src: relPath, title: '' }
      const node = t.create(attrs)
      insertBlockAtSelection(view, node)
    } catch (err) {
      console.warn('[media-drop-paste] insert failed', {
        name: file.name,
        kind,
        err,
      })
    }
  }
  view.focus()
  // See the matching comment in slashItems.ts::insertImage — close
  // the race window between the binary write and the doc save so
  // the watcher's echo suppression catches every fsevent we
  // produced.
  void flushDirty()
}

export const mediaDropPastePlugin = $prose(
  () =>
    new Plugin({
      props: {
        handleDrop(view, event, _slice, moved) {
          // Internal moves (dragging an existing node within the
          // editor) carry no files and PM handles them — bail out
          // explicitly so we never compete with the default move
          // behaviour.
          if (moved) return false
          const files = filterMediaFiles(event.dataTransfer?.files)
          if (files.length === 0) return false
          event.preventDefault()

          // Resolve drop coords → doc position. Fallback to current
          // selection if the coords don't map (drop outside content).
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
          const pos = at?.pos ?? view.state.selection.from
          const resolved = view.state.doc.resolve(pos)
          view.dispatch(
            view.state.tr.setSelection(TextSelection.near(resolved)),
          )
          void insertMediaAtSelection(view, files)
          return true
        },

        handlePaste(view, event) {
          const files = filterMediaFiles(event.clipboardData?.files)
          if (files.length === 0) return false
          event.preventDefault()
          void insertMediaAtSelection(view, files)
          return true
        },
      },
    }),
)
