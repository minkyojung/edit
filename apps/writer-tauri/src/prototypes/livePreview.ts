// Live Preview decoration engine for the CM spike (Tier 1 + Tier 2).
//
// One pass over the @lezer/markdown syntax tree builds a DecorationSet:
//   - line decorations style headings / blockquote / code blocks / hr
//   - mark decorations style bold / italic / code / links / wikilinks
//   - replace decorations HIDE syntax markers (`#`, `**`, backticks, `>`,
//     link brackets/url) — UNLESS the cursor is on that line (Obsidian
//     reveal) — and swap atomic objects (image, checkbox, bullet, table)
//     for widgets.
// Markers + widgets are also exposed as atomicRanges so the caret skips
// the now-invisible source.
//
// Throwaway visual spike. Scans only visibleRanges; builds an array and
// Decoration.set(arr, true) so out-of-order tree walks can't trip RangeSet.

import { syntaxTree } from '@codemirror/language'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { BulletWidget, CheckboxWidget, ImageWidget, TableWidget } from './widgets'

const HIDE = Decoration.replace({})

interface Built {
  decos: Range<Decoration>[]
  atomic: Range<Decoration>[]
}

/** Line numbers touched by any selection range — markers on these lines
 * stay raw (the reveal rule). */
export function activeLines(state: EditorState): Set<number> {
  const set = new Set<number>()
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number
    const b = state.doc.lineAt(r.to).number
    for (let n = a; n <= b; n++) set.add(n)
  }
  return set
}

function spansActiveLine(state: EditorState, from: number, to: number, active: Set<number>): boolean {
  const a = state.doc.lineAt(from).number
  const b = state.doc.lineAt(Math.min(to, state.doc.length)).number
  for (let n = a; n <= b; n++) if (active.has(n)) return true
  return false
}

/** Build decorations over `ranges`. Exported (and view-free) so it can be
 * unit-tested headlessly with just an EditorState. */
export function buildDecorations(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
  active: Set<number>,
): Built {
  const decos: Range<Decoration>[] = []
  const atomic: Range<Decoration>[] = []
  const tree = syntaxTree(state)
  const sliceOf = (from: number, to: number) => state.doc.sliceString(from, to)

  const lineClass = (pos: number, cls: string) =>
    decos.push(Decoration.line({ class: cls }).range(state.doc.lineAt(pos).from))
  const eachLineClass = (from: number, to: number, cls: string) => {
    let n = state.doc.lineAt(from).number
    const end = state.doc.lineAt(Math.min(to, state.doc.length)).number
    for (; n <= end; n++) lineClass(state.doc.line(n).from, cls)
  }
  const hide = (from: number, to: number) => {
    if (to <= from) return
    const r = HIDE.range(from, to)
    decos.push(r)
    atomic.push(r)
  }
  const widget = (from: number, to: number, w: Decoration) => {
    const r = w.range(from, to)
    decos.push(r)
    atomic.push(r)
  }
  const mark = (from: number, to: number, cls: string) => {
    if (to > from) decos.push(Decoration.mark({ class: cls }).range(from, to))
  }

  for (const { from: rFrom, to: rTo } of ranges) {
    tree.iterate({
      from: rFrom,
      to: rTo,
      enter: (node) => {
        const { name } = node
        const nf = node.from
        const nt = node.to
        const revealed = spansActiveLine(state, nf, nt, active)

        // Headings
        if (/^ATXHeading[1-6]$/.test(name)) {
          lineClass(nf, `cm-h${name.slice(-1)}`)
          return
        }
        if (name === 'HeaderMark') {
          if (!revealed) {
            // also swallow the single trailing space after `#`
            const trailing = sliceOf(nt, nt + 1) === ' ' ? 1 : 0
            hide(nf, nt + trailing)
          }
          return
        }

        // Emphasis
        if (name === 'StrongEmphasis') return void mark(nf, nt, 'cm-strong')
        if (name === 'Emphasis') return void mark(nf, nt, 'cm-em')
        if (name === 'Strikethrough') return void mark(nf, nt, 'cm-strike')
        if (name === 'EmphasisMark' || name === 'StrikethroughMark') {
          if (!revealed) hide(nf, nt)
          return
        }

        // Inline code
        if (name === 'InlineCode') return void mark(nf, nt, 'cm-inline-code')
        if (name === 'CodeMark') {
          if (!revealed) hide(nf, nt)
          return
        }

        // Links
        if (name === 'Link') return void mark(nf, nt, 'cm-link')
        if (name === 'URL' || name === 'LinkMark') {
          if (!revealed) hide(nf, nt)
          return
        }

        // Image — replace whole node with an <img>; don't descend.
        if (name === 'Image') {
          if (!revealed) {
            const m = /!\[([^\]]*)\]\(([^)\s]+)/.exec(sliceOf(nf, nt))
            if (m) widget(nf, nt, Decoration.replace({ widget: new ImageWidget(m[2], m[1]) }))
          }
          return false
        }

        // Blockquote
        if (name === 'Blockquote') {
          eachLineClass(nf, nt, 'cm-blockquote')
          return
        }
        if (name === 'QuoteMark') {
          if (!revealed) {
            const trailing = sliceOf(nt, nt + 1) === ' ' ? 1 : 0
            hide(nf, nt + trailing)
          }
          return
        }

        // Lists
        if (name === 'ListMark') {
          const item = node.node.parent
          const list = item?.parent
          const ordered = list?.name === 'OrderedList'
          if (ordered) {
            mark(nf, nt, 'cm-list-num')
            return
          }
          if (revealed) return
          // Task items render a checkbox instead of a bullet → hide the dash.
          if (item?.getChild('Task')) {
            hide(nf, sliceOf(nt, nt + 1) === ' ' ? nt + 1 : nt)
          } else {
            const trailing = sliceOf(nt, nt + 1) === ' ' ? 1 : 0
            widget(nf, nt + trailing, Decoration.replace({ widget: new BulletWidget() }))
          }
          return
        }
        if (name === 'TaskMarker') {
          if (!revealed) {
            const checked = /[xX]/.test(sliceOf(nf, nt))
            const trailing = sliceOf(nt, nt + 1) === ' ' ? 1 : 0
            widget(nf, nt + trailing, Decoration.replace({ widget: new CheckboxWidget(checked) }))
          }
          return
        }

        // Horizontal rule — reveal raw `---` on the active line.
        if (name === 'HorizontalRule') {
          if (!revealed) lineClass(nf, 'cm-hr')
          return
        }

        // Fenced code — style the block lines (fences kept, look fine in mono).
        // `mermaid` fences are owned by the mermaidCards StateField (block
        // widget), so skip them here to avoid line/block decoration overlap.
        if (name === 'FencedCode') {
          const info = state.doc.lineAt(nf).text.replace(/^(```|~~~)/, '').trim()
          if (info === 'mermaid') return
          eachLineClass(nf, nt, 'cm-code-block')
          return
        }

        // GFM table — replace the whole block with a real <table>.
        if (name === 'Table') {
          if (!revealed) {
            const from = state.doc.lineAt(nf).from
            const to = state.doc.lineAt(Math.min(nt, state.doc.length)).to
            widget(from, to, Decoration.replace({ widget: new TableWidget(sliceOf(from, to)), block: true }))
          }
          return false
        }

        return
      },
    })

    // Wikilinks `[[Title]]` — not in the markdown grammar, so a regex overlay
    // over the same ranges. Same array + sort, so ordering stays safe.
    const text = sliceOf(rFrom, rTo)
    const re = /\[\[([^\]]+)\]\]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const start = rFrom + m.index
      const innerFrom = start + 2
      const innerTo = start + 2 + m[1].length
      const end = innerTo + 2
      mark(innerFrom, innerTo, 'cm-wikilink')
      if (!spansActiveLine(state, start, end, active)) {
        hide(start, innerFrom)
        hide(innerTo, end)
      }
    }
  }

  return { decos, atomic }
}

interface LpState {
  deco: DecorationSet
  atomic: DecorationSet
}

function compute(state: EditorState): LpState {
  const { decos, atomic } = buildDecorations(
    state,
    [{ from: 0, to: state.doc.length }],
    activeLines(state),
  )
  return { deco: Decoration.set(decos, true), atomic: Decoration.set(atomic, true) }
}

// A StateField — NOT a ViewPlugin — because the GFM table uses a block
// decoration, and CodeMirror only accepts block decorations from a field.
// Scans the whole (small) doc; recomputes on doc OR selection change (the
// latter drives the cursor-reveal). No viewport optimization needed at
// spike scale.
const lpField = StateField.define<LpState>({
  create: (state) => compute(state),
  update: (value, tr) => (tr.docChanged || tr.selection ? compute(tr.state) : value),
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.deco),
    EditorView.atomicRanges.of((view) => view.state.field(f).atomic),
  ],
})

export const livePreview: Extension = lpField
