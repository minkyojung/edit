import { EditorView } from '@codemirror/view'
import type { EditorState } from '@codemirror/state'
import { markdownToHtml } from '@/lib/markdownToHtml'
import { embedLocalImages } from '@/lib/embedLocalImages'

// Cmd+C / Cmd+X over a selection puts BOTH text/html (rendered) and
// text/plain (markdown source) on the clipboard, so pasting the
// selection into an external rich editor (Substack, Notion, Docs,
// CodeMirror, ProseMirror) keeps formatting instead of dumping raw
// `##`/`-` source. This is the automatic-copy counterpart to the
// "Copy as rich text" menu action — same markdownToHtml pipeline.
//
// An empty selection falls through to CodeMirror's default handling
// (which copies the current line as plain text), so we don't change
// that ergonomic.

/** Build the clipboard payload for the current selection, or null when
 * nothing is selected. Pure (no DOM) so it can be unit-tested against a
 * plain EditorState. Multiple selection ranges are joined with newlines,
 * matching CodeMirror's own multi-selection copy. */
export function richClipboardPayload(
  state: EditorState,
): { md: string; html: string } | null {
  const ranges = state.selection.ranges.filter((r) => !r.empty)
  if (ranges.length === 0) return null
  const md = ranges.map((r) => state.sliceDoc(r.from, r.to)).join('\n')
  return { md, html: markdownToHtml(md) }
}

/** Best-effort second write: if the selection had vault-local images,
 * re-encode them as base64 and overwrite the clipboard so they survive
 * a paste. Reading image bytes is async and can't happen inside the
 * synchronous copy event, so the sync setData above is the baseline
 * (text + remote images always work) and this only ever upgrades it —
 * a fast paste before this resolves just gets the un-embedded version,
 * never a broken copy. No local images → embedLocalImages returns the
 * same string and we skip the extra clipboard write entirely. */
async function upgradeWithEmbeddedImages(md: string, html: string): Promise<void> {
  const embedded = await embedLocalImages(html)
  if (embedded === html) return
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([embedded], { type: 'text/html' }),
        'text/plain': new Blob([md], { type: 'text/plain' }),
      }),
    ])
  } catch {
    /* sync baseline is already on the clipboard */
  }
}

function writeRich(event: ClipboardEvent, view: EditorView, isCut: boolean): boolean {
  const payload = richClipboardPayload(view.state)
  if (!payload || !event.clipboardData) return false
  event.clipboardData.setData('text/plain', payload.md)
  event.clipboardData.setData('text/html', payload.html)
  event.preventDefault()
  void upgradeWithEmbeddedImages(payload.md, payload.html)
  if (isCut) {
    // We prevented the default, so CodeMirror won't delete — do it here.
    view.dispatch(
      view.state.update({
        changes: view.state.selection.ranges
          .filter((r) => !r.empty)
          .map((r) => ({ from: r.from, to: r.to })),
        userEvent: 'delete.cut',
        scrollIntoView: true,
      }),
    )
  }
  return true
}

export const richTextCopy = EditorView.domEventHandlers({
  copy: (event, view) => writeRich(event, view, false),
  cut: (event, view) => writeRich(event, view, true),
})
