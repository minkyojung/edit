// Clean live-preview decoration engine (v2). Built one verified layer at a time.
//
// STEP 2 — REVEAL. On top of step 1's styling, hide a construct's markers (`#`,
// `**`, `*`, `~~`, backticks) with a replace decoration WHEN the caret is not on
// it, and show them raw when it is (Obsidian-style editing). This adds:
//   • replace ("hide") decorations — inline + single-line only, so still legal
//     from a ViewPlugin (CM forbids only block / line-break-crossing replaces).
//   • selection dependence — reveal changes as the caret moves, so we rebuild on
//     selectionSet too.
// NOT yet added (on purpose, to isolate risk — add only if observed):
//   • atomicRanges (caret skipping hidden markers) — step 2b
//   • IME composition freeze (replace near composing text) — step 2c

import { syntaxTree } from '@codemirror/language'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { type EditorState, type Range } from '@codemirror/state'
import { isKnownNote } from '../wikilinkComplete'

const HIDE = Decoration.replace({})

/** Any selection range touches [from, to] (inclusive — an edge counts, so a
 * just-typed marker stays raw until the caret moves off). */
function cursorInRange(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) {
    if (r.from <= to && from <= r.to) return true
  }
  return false
}

function buildDecos(state: EditorState, ranges: readonly { from: number; to: number }[]): Range<Decoration>[] {
  const out: Range<Decoration>[] = []
  const tree = syntaxTree(state)
  const mark = (from: number, to: number, cls: string) => {
    if (to > from) out.push(Decoration.mark({ class: cls }).range(from, to))
  }
  const hide = (from: number, to: number) => {
    if (to > from) out.push(HIDE.range(from, to))
  }
  const eachLineClass = (from: number, to: number, cls: string) => {
    let n = state.doc.lineAt(from).number
    const end = state.doc.lineAt(Math.min(to, state.doc.length)).number
    for (; n <= end; n++) out.push(Decoration.line({ class: cls }).range(state.doc.line(n).from))
  }
  for (const { from, to } of ranges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const { name } = node
        const nf = node.from
        const nt = node.to

        // Headings — line-level reveal: hide `# ` unless the caret is on the line.
        if (/^ATXHeading[1-6]$/.test(name)) {
          out.push(Decoration.line({ class: `cm-h${name.slice(-1)}` }).range(state.doc.lineAt(nf).from))
          return
        }
        if (name === 'HeaderMark') {
          const line = state.doc.lineAt(nf)
          if (!cursorInRange(state, line.from, line.to)) {
            const trailing = state.doc.sliceString(nt, nt + 1) === ' ' ? 1 : 0
            hide(nf, nt + trailing)
          }
          return
        }

        // Emphasis / inline code — per-construct reveal: hide the markers unless
        // the caret is anywhere inside the PARENT construct (so both the opening
        // and closing markers reveal together).
        if (name === 'StrongEmphasis') return void mark(nf, nt, 'cm-strong')
        if (name === 'Emphasis') return void mark(nf, nt, 'cm-em')
        if (name === 'Strikethrough') return void mark(nf, nt, 'cm-strike')
        if (name === 'InlineCode') return void mark(nf, nt, 'cm-inline-code')
        // Link `[text](url)` — style the whole node; hide the `[`/`](url)` markers.
        if (name === 'Link') return void mark(nf, nt, 'cm-link')
        if (
          name === 'EmphasisMark' ||
          name === 'StrikethroughMark' ||
          name === 'CodeMark' ||
          name === 'LinkMark' ||
          name === 'URL'
        ) {
          const p = node.node.parent
          const reveal = p ? cursorInRange(state, p.from, p.to) : cursorInRange(state, nf, nt)
          if (!reveal) hide(nf, nt)
          return
        }

        // Blockquote — line class on each line; `>` hidden unless the caret is on
        // that line (line-level reveal, like headings). All line decorations →
        // no widgets → no "earthquake".
        if (name === 'Blockquote') {
          eachLineClass(nf, nt, 'cm-blockquote')
          return
        }
        if (name === 'QuoteMark') {
          const line = state.doc.lineAt(nf)
          if (!cursorInRange(state, line.from, line.to)) {
            const trailing = state.doc.sliceString(nt, nt + 1) === ' ' ? 1 : 0
            hide(nf, nt + trailing)
          }
          return
        }

        // Horizontal rule — render as a ruled line (cm-hr hides the text + draws a
        // border) unless the caret is on the line, then show raw `---`.
        if (name === 'HorizontalRule') {
          const line = state.doc.lineAt(nf)
          if (!cursorInRange(state, line.from, line.to)) {
            out.push(Decoration.line({ class: 'cm-hr' }).range(line.from))
          }
          return
        }

        // Fenced code — style every line (fences stay visible; mono looks fine).
        // No reveal toggle.
        if (name === 'FencedCode') {
          eachLineClass(nf, nt, 'cm-code-block')
          return
        }

        // List bullet (STEP 1) — `- `/`* `/`+ ` → • drawn over the dash with CSS
        // (the mark sets visibility:hidden + an absolute ::after '•'). Same width
        // as the dash, so NOTHING reflows. Rendered only when the marker is
        // followed by a space (a real item). Ordered/task markers + reveal come in
        // later steps; for now the bullet is ALWAYS shown (no caret toggle).
        if (name === 'ListMark') {
          const item = node.node.parent
          if (item?.parent?.name === 'OrderedList' || item?.getChild('Task')) return // bullet only
          if (state.doc.sliceString(nt, nt + 1) !== ' ') return // `- ` only
          mark(nf, nt, 'cm-list-bullet')
          return
        }
      },
    })

    // Wikilinks `[[Title]]` — not in the markdown grammar, so a regex overlay over
    // the same range. Mark the inner title (broken-styled if the note is unknown)
    // and hide `[[`/`]]` unless the caret is inside the whole `[[...]]`.
    const text = state.doc.sliceString(from, to)
    const re = /\[\[([^\]\n]+)\]\]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const start = from + m.index
      const innerFrom = start + 2
      const innerTo = innerFrom + m[1].length
      const end = innerTo + 2
      mark(innerFrom, innerTo, isKnownNote(m[1]) ? 'cm-wikilink' : 'cm-wikilink-broken')
      if (!cursorInRange(state, start, end)) {
        hide(start, innerFrom)
        hide(innerTo, end)
      }
    }
  }
  return out
}

export const livePreviewV2 = ViewPlugin.fromClass(
  class {
    deco: DecorationSet
    constructor(view: EditorView) {
      this.deco = this.build(view)
    }
    build(view: EditorView): DecorationSet {
      return Decoration.set(buildDecos(view.state, view.visibleRanges), true)
    }
    update(u: ViewUpdate) {
      // Reveal depends on the selection now, so rebuild on selection changes too.
      if (u.docChanged || u.viewportChanged || u.selectionSet) this.deco = this.build(u.view)
    }
  },
  { decorations: (v) => v.deco },
)
