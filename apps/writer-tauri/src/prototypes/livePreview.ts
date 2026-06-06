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
import { CheckboxWidget, ImageWidget, TableWidget } from './widgets'
import { isKnownNote } from './wikilinkComplete'
import { isComposing, compositionEnded } from './imeComposition'

const HIDE = Decoration.replace({})

// List-item line decoration (Obsidian-style structural hanging indent).
// The marker lives OUT of the text flow (absolutely positioned in a reserved
// gutter — see widgets + cmTheme), so the line reserves a FIXED content column
// via `padding-inline-start`. Because the padding applies to EVERY visual row,
// wrapped rows align exactly under the first row's content — with no `ch`
// measurement and no `text-indent` (avoids the rectangular-selection bug,
// discuss.codemirror#2881). Indent is glyph-independent fixed em, so it can't
// drift per font. `SLOT` = marker gutter width; `STEP` = per-nesting-level step.
// Two CSS vars are exposed: `--cm-list-pad` (content column) and
// `--cm-list-marker-left` (gutter offset the absolute marker reads).
const LIST_SLOT = 1.6 // em — holds •, a checkbox, or "1."/"99."
const LIST_STEP = 1.6 // em — per nesting level
const listLineCache = new Map<string, Decoration>()
function listLine(level: number, markerClass = ''): Decoration {
  const key = `${level}:${markerClass}`
  let d = listLineCache.get(key)
  if (!d) {
    const left = level * LIST_STEP
    d = Decoration.line({
      class: ('cm-list-line ' + markerClass).trim(),
      attributes: {
        style: `--cm-list-pad:${left + LIST_SLOT}em;--cm-list-marker-left:${left}em`,
      },
    })
    listLineCache.set(key, d)
  }
  return d
}

/** Nesting depth of a list ITEM node (0 = top level), counted from the
 * Bullet/Ordered list ancestors in the syntax tree. */
function listLevel(item: import('@lezer/common').SyntaxNode | null): number {
  let level = -1
  for (let p = item?.parent ?? null; p; p = p.parent) {
    if (p.name === 'BulletList' || p.name === 'OrderedList') level++
  }
  return Math.max(0, level)
}

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

/** A COLLAPSED caret sits within [from, to] (inclusive). Unlike `editing`, a
 * non-empty selection that merely SPANS the range does NOT count — so Select-All
 * or a drag keeps structural list markers rendered (and `user-select:none` keeps
 * them out of the highlight), matching Obsidian. */
function caretIn(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) {
    if (r.empty && r.from >= from && r.from <= to) return true
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

        // Lists. The marker is rendered structurally — out of the text flow,
        // in a fixed gutter — so wrapped rows align under the content and the
        // marker can't be drag-selected (Obsidian behavior). Caret ON the
        // marker → raw source (the reveal rule). Ordered/task branches keep
        // their prior rendering for now (Stages 3/2 restructure them).
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
            // caret is on the `- [ ]` PREFIX. Reveal region ends at the task
            // marker, NOT the whole item — so editing the task TEXT keeps the
            // checkbox rendered (Obsidian behavior).
            const marker = task.getChild('TaskMarker')
            const prefixEnd = marker?.to ?? task.to
            if (!editing(state, nf, prefixEnd)) {
              hide(nf, sliceOf(nt, nt + 1) === ' ' ? nt + 1 : nt)
            }
            return
          }
          // Bullet — structural, drawn by `.cm-list-bullet::before` (Obsidian's
          // approach). We HIDE the `- ` rather than swap a widget: a pseudo-
          // element isn't a DOM tile, so an EMPTY item's line stays a normal
          // (text-less) line and the caret keeps its normal height — a widget
          // would leave the line with no in-flow text and inflate the caret.
          // A COLLAPSED caret ON the marker → raw (typing `-` shows raw until the
          // caret moves off). A non-empty SELECTION (drag / Select-All) does NOT
          // reveal — the hidden `- ` and the pseudo-element stay out of the
          // highlight, so only the text is selected (Obsidian).
          if (caretIn(state, nf, nt)) return
          const ln = state.doc.lineAt(nf)
          hide(ln.from, nf) // leading indent (no-op at top level); CSS reproduces it
          const trailing = sliceOf(nt, nt + 1) === ' ' ? 1 : 0
          hide(nf, nt + trailing) // the `- ` itself; bullet glyph comes from CSS
          decos.push(listLine(listLevel(item), 'cm-list-bullet').range(ln.from))
          return
        }
        if (name === 'TaskMarker') {
          // Reveal region = the `- [ ]` prefix (dash → marker end), NOT the
          // whole task item — editing the task text keeps the checkbox.
          const dash = node.node.parent?.parent?.getChild('ListMark')
          const from = dash?.from ?? nf
          if (editing(state, from, nt)) return // caret on the prefix → raw
          const checked = /[xX]/.test(sliceOf(nf, nt))
          const trailing = sliceOf(nt, nt + 1) === ' ' ? 1 : 0
          // `nf + 1` = the status char between the brackets, the click target.
          widget(nf, nt + trailing, Decoration.replace({ widget: new CheckboxWidget(checked, nf + 1) }))
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
