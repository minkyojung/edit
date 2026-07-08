// Render arbitrary markdown READ-ONLY through the SAME pipeline the document uses
// (markdown + livePreviewV2 + blocksV2). A proof-suggestion preview then shows the
// real thing — image as image, table as table, video as video — with ZERO per-type
// preview code. New block types added to blocksV2 preview for free. This is the same
// nested-editor pattern the table cells already use, so no new risk.

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { livePreviewV2 } from './livePreview'
import { blocksV2 } from './blocks'
import { cmPrototypeTheme } from '../cmTheme'

// cmPrototypeTheme adds the full editor's page padding / max-width — a preview tile
// must hug its content instead. The reset lives in cmTheme.ts under
// `.cm-proof-preview` (same pattern as the `.cm-celledit` cell reset): scoping under
// the host class out-specifies both the parent theme's leak and this nested editor's
// own theme instance, which an equal-specificity local theme could not reliably beat.

/** Mount a read-only mini editor rendering `text` (leading/trailing blank lines
 * trimmed so an insertion's newline padding doesn't show as empty rows). Caller owns
 * teardown — call `.destroy()` when the host widget is removed. */
export function renderMarkdownReadonly(parent: HTMLElement, text: string): EditorView {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: text.replace(/^\n+|\n+$/g, ''),
      extensions: [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.lineWrapping,
        markdown({ extensions: [GFM], addKeymap: false }),
        livePreviewV2,
        blocksV2,
        cmPrototypeTheme,
      ],
    }),
  })
}
