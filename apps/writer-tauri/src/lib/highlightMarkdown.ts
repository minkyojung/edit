// Static markdown syntax highlighter — colours a single line of markdown SOURCE
// using the SAME parser the editor runs (@codemirror/lang-markdown + GFM) plus
// CodeMirror's standard token classifier. Used by DiffBlock so a pending change's
// +/- lines read like coloured source instead of flat text.
//
// Why per-line: diff lines are already split line-by-line; markdown block context
// (heading / list / quote) is line-local, so parsing each line on its own is both
// simpler and robust (a half-shown code fence can't bleed colour into later lines).
//
// "CodeMirror reuse" not "editor reuse": the document editor styles markdown via a
// live-preview (bold renders bold), not via source-token colours — there's no editor
// palette to copy. We reuse CM's PARSER + classifier; the colours live in
// components/diffHighlight.css, keyed by the `tok-*` classes classHighlighter emits.

import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { highlightTree, classHighlighter } from '@lezer/highlight'

// Build the parser once. Same options as the editor (CmEditor.tsx) so tokenisation
// matches exactly.
const parser = markdown({ extensions: [GFM], addKeymap: false }).language.parser

/** One coloured run of text. `cls` is the space-separated `tok-*` class string
 * (empty for unhighlighted text). */
export interface HlSeg {
  text: string
  cls: string
}

/** Tokenise one line of markdown source into coloured segments. Pure — returns the
 * whole line as a single uncoloured segment when nothing matches (e.g. plain prose). */
export function highlightMarkdownLine(code: string): HlSeg[] {
  if (code.length === 0) return [{ text: '', cls: '' }]
  const tree = parser.parse(code)
  const segs: HlSeg[] = []
  let pos = 0
  highlightTree(tree, classHighlighter, (from, to, cls) => {
    if (from > pos) segs.push({ text: code.slice(pos, from), cls: '' })
    segs.push({ text: code.slice(from, to), cls })
    pos = to
  })
  if (pos < code.length) segs.push({ text: code.slice(pos), cls: '' })
  return segs
}
