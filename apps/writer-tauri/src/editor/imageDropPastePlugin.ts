// Drag-and-drop + clipboard-paste handler for images.
//
// The slash menu already covers explicit insertion via file dialog;
// this plugin handles the two other paths every note-app user
// expects:
//   - Drag an image file from Finder → drop into the editor.
//   - Take a screenshot (Cmd+Shift+4 on macOS) → Cmd+V into the
//     editor. The screenshot arrives as a PNG `File` on the
//     clipboard with no source path.
//
// Both paths converge on `importImageFile(file)` so the vault
// dedupe + write rule lives in one place (lib/vaultImages.ts).
//
// ProseMirror's `handleDrop` / `handlePaste` props are the canonical
// interception points. Returning `true` tells PM "I owned this
// event"; returning `false` lets PM run its default behaviour
// (which would try to serialise the dropped/pasted content as
// markdown — useless for an image File).
//
// The async copy-into-vault step runs *outside* the transaction.
// We move the selection to the drop position first, then dispatch
// one transaction per image as each `arrayBuffer()` resolves. This
// keeps each insert atomic from PM's perspective.

import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { insertBlockAtSelection } from './insertImage'
import { importImageFile } from '@/lib/vaultImages'
import { flushDirty } from '@/lib/docFileSync'

function filterImageFiles(list: FileList | null | undefined): File[] {
  if (!list) return []
  return Array.from(list).filter((f) => f.type.startsWith('image/'))
}

async function insertImagesAtSelection(
  view: EditorView,
  files: File[],
): Promise<void> {
  for (const file of files) {
    try {
      const relPath = await importImageFile(file)
      const alt = file.name.replace(/\.[^.]+$/, '')
      const t = view.state.schema.nodes.imageBlock
      if (!t) continue
      const node = t.create({ src: relPath, alt, title: '' })
      insertBlockAtSelection(view, node)
    } catch (err) {
      console.warn('[image-drop-paste] insert failed', { name: file.name, err })
    }
  }
  view.focus()
  // See the matching comment in slashItems.ts::insertImage — close
  // the race window between the image binary write and the doc save
  // so the watcher's echo suppression catches every fsevent we
  // produced.
  void flushDirty()
}

export const imageDropPastePlugin = $prose(
  () =>
    new Plugin({
      props: {
        handleDrop(view, event, _slice, moved) {
          // Internal moves (dragging an existing node within the
          // editor) carry no files and PM handles them — bail out
          // explicitly so we never compete with the default move
          // behaviour.
          if (moved) return false
          const files = filterImageFiles(event.dataTransfer?.files)
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
          void insertImagesAtSelection(view, files)
          return true
        },

        handlePaste(view, event) {
          const files = filterImageFiles(event.clipboardData?.files)
          if (files.length === 0) return false
          event.preventDefault()
          void insertImagesAtSelection(view, files)
          return true
        },
      },
    }),
)
