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

const HIDE = Decoration.replace({})

/** Any selection range touches [from, to] (inclusive — an edge counts, so a
 * just-typed marker stays raw until the caret moves off). */
function cursorInRange(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) {
    if (r.from <= to && from <= r.to) return true
  }
  return false
}

// STEP 3a — list LAYOUT only. One uniform line decoration per list line: reserve
// the content column with `padding-inline-start` (= level*STEP + GUTTER) and pull
// the first row back by one gutter with a negative `text-indent` (CSS in
// cmTheme). Markers stay RAW here — glyphs (•/number/checkbox) come in 3b/3c.
const LIST_GUTTER = 1.5 // em — content column / marker-column width
const LIST_STEP = 1.5 // em — added per nesting level
const listLineCache = new Map<number, Decoration>()
function listLine(level: number): Decoration {
  let d = listLineCache.get(level)
  if (!d) {
    d = Decoration.line({
      class: 'cm-list-line',
      attributes: { style: `--cm-list-pad:${level * LIST_STEP + LIST_GUTTER}em` },
    })
    listLineCache.set(level, d)
  }
  return d
}

/** Nesting depth of a list ITEM (0 = top level), from Bullet/Ordered ancestors. */
function listLevel(item: import('@lezer/common').SyntaxNode | null): number {
  let level = -1
  for (let p = item?.parent ?? null; p; p = p.parent) {
    if (p.name === 'BulletList' || p.name === 'OrderedList') level++
  }
  return Math.max(0, level)
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
        if (name === 'EmphasisMark' || name === 'StrikethroughMark' || name === 'CodeMark') {
          const p = node.node.parent
          const reveal = p ? cursorInRange(state, p.from, p.to) : cursorInRange(state, nf, nt)
          if (!reveal) hide(nf, nt)
          return
        }

        // Lists — STEP 3a: layout only. One line decoration; marker stays raw.
        if (name === 'ListMark') {
          out.push(listLine(listLevel(node.node.parent)).range(state.doc.lineAt(nf).from))
          return
        }
      },
    })
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
