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
import { isKnownNote } from './wikilinkComplete'
import { isComposing, compositionEnded } from './imeComposition'

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

// ── The reveal predicate (uniform, Obsidian/Ixora-style) ────────────────
// A construct shows its rendered form ⟺ it is COMPLETE and the caret is NOT
// editing it. "editing" = the selection touches the construct's edit region
// (INCLUSIVE — touching an edge counts), so a just-typed marker (caret at its
// end) stays raw, and the construct renders once the caret moves off it.
//   - wrapping marks (bold/italic/code/link): edit region = the whole construct
//   - prefix markers (list/heading/quote):    edit region = the marker token
// (Blocks heading/quote/hr/table additionally use line-level reveal below.)

/** Selection touches [from, to] (inclusive). */
function editing(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) {
    if (r.from <= to && from <= r.to) return true
  }
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
        // Block constructs use line-level reveal; inline marks use per-construct
        // (range) reveal via `editing`. `inlineRevealed` checks the PARENT
        // construct's range so both opening + closing markers reveal together
        // whenever the caret is anywhere inside the construct.
        const revealed = spansActiveLine(state, nf, nt, active)
        const parent = node.node.parent
        const inlineRevealed = parent
          ? editing(state, parent.from, parent.to)
          : editing(state, nf, nt)

        // Headings (block-level reveal)
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

        // Emphasis (inline — per-construct reveal)
        if (name === 'StrongEmphasis') return void mark(nf, nt, 'cm-strong')
        if (name === 'Emphasis') return void mark(nf, nt, 'cm-em')
        if (name === 'Strikethrough') return void mark(nf, nt, 'cm-strike')
        if (name === 'EmphasisMark' || name === 'StrikethroughMark') {
          if (!inlineRevealed) hide(nf, nt)
          return
        }

        // Inline code
        if (name === 'InlineCode') return void mark(nf, nt, 'cm-inline-code')
        if (name === 'CodeMark') {
          if (!inlineRevealed) hide(nf, nt)
          return
        }

        // Links
        if (name === 'Link') return void mark(nf, nt, 'cm-link')
        if (name === 'URL' || name === 'LinkMark') {
          if (!inlineRevealed) hide(nf, nt)
          return
        }

        // Image — replace whole node with an <img>; don't descend. Reveal raw
        // only when the caret is inside the image markdown itself.
        if (name === 'Image') {
          if (!editing(state, nf, nt)) {
            const m = /!\[([^\]]*)\]\(([^)\s]+)/.exec(sliceOf(nf, nt))
            if (m) widget(nf, nt, Decoration.replace({ widget: new ImageWidget(m[2], m[1]) }))
          }
          return false
        }

        // Blockquote (block-level reveal)
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

        // Lists. A marker only turns into a glyph once it's COMPLETE and the
        // caret isn't on the marker itself — so typing `-` (before the space)
        // or editing the marker shows raw, but editing the item's CONTENT
        // keeps the bullet (matches Obsidian). Ordered numbers stay as text.
        if (name === 'ListMark') {
          const item = node.node.parent
          const list = item?.parent
          if (list?.name === 'OrderedList') {
            mark(nf, nt, 'cm-list-num')
            return
          }
          const task = item?.getChild('Task')
          if (task) {
            // Task: hide the dash (the checkbox shows the marker) unless the
            // caret is on the `- [ ]` prefix.
            if (!editing(state, nf, task.to)) {
              hide(nf, sliceOf(nt, nt + 1) === ' ' ? nt + 1 : nt)
            }
            return
          }
          // Complete (`- ` with the space) + caret off the dash token → bullet.
          // Edit region is the dash itself, so the caret at content-start (just
          // past the space) still renders the bullet.
          if (sliceOf(nt, nt + 1) !== ' ') return // incomplete `-` → leave raw
          if (editing(state, nf, nt)) return // caret on the marker → raw
          widget(nf, nt + 1, Decoration.replace({ widget: new BulletWidget() }))
          return
        }
        if (name === 'TaskMarker') {
          const task = node.node.parent
          const region = task ?? { from: nf, to: nt }
          if (editing(state, region.from, region.to)) return // caret on marker → raw
          const checked = /[xX]/.test(sliceOf(nf, nt))
          const trailing = sliceOf(nt, nt + 1) === ' ' ? 1 : 0
          widget(nf, nt + trailing, Decoration.replace({ widget: new CheckboxWidget(checked) }))
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
      mark(innerFrom, innerTo, isKnownNote(m[1]) ? 'cm-wikilink' : 'cm-wikilink-broken')
      // Per-construct reveal: only show `[[ ]]` when the caret is inside it.
      if (!editing(state, start, end)) {
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
  update: (value, tr) => {
    // IME: freeze decorations while composing so the composing DOM stays put.
    if (isComposing(tr.state)) return value
    if (tr.docChanged || tr.selection || compositionEnded(tr)) return compute(tr.state)
    return value
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.deco),
    EditorView.atomicRanges.of((view) => view.state.field(f).atomic),
  ],
})

export const livePreview: Extension = lpField
