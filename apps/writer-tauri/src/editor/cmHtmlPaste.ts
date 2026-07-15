// Rich HTML paste → markdown.
//
// When you copy a web article (or a Google-Docs / Word selection) and
// paste it into the editor, the clipboard's text/html carries the real
// structure — headings, lists, tables, links, images. CodeMirror's
// default paste only takes text/plain, which flattens all of that. This
// handler converts the html to markdown so structure survives.
//
// It is deliberately conservative — it only takes over when the paste is
// genuinely rich AND the cursor isn't in a code context; everything else
// falls through to CodeMirror's default plain-text paste. That keeps
// code snippets and plain text pastes untouched.

import { EditorView } from '@codemirror/view'
import type { EditorState, Extension } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { htmlToMarkdown, isRichHtml } from '@/lib/htmlToMarkdown'

/** True when `pos` sits inside a fenced/indented code block or inline
 * code — where a paste should stay literal rather than be re-parsed as
 * markdown. */
export function inCodeContext(state: EditorState, pos: number): boolean {
  for (
    let node: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(
      state,
    ).resolveInner(pos, -1);
    node;
    node = node.parent
  ) {
    const name = node.name
    if (
      name === 'FencedCode' ||
      name === 'CodeBlock' ||
      name === 'CodeText' ||
      name === 'InlineCode'
    ) {
      return true
    }
  }
  return false
}

export const htmlPaste: Extension = EditorView.domEventHandlers({
  paste(event, view) {
    // Files (screenshots, dragged image files) are the media handler's job.
    if (event.clipboardData?.files?.length) return false
    const html = event.clipboardData?.getData('text/html')
    if (!html || !isRichHtml(html)) return false
    // Don't re-parse a paste that lands inside a code block.
    if (inCodeContext(view.state, view.state.selection.main.head)) return false
    const md = htmlToMarkdown(html)
    if (!md) return false
    view.dispatch({
      ...view.state.replaceSelection(md),
      userEvent: 'input.paste',
      scrollIntoView: true,
    })
    event.preventDefault()
    return true
  },
})
