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
import { CheckboxWidget, ImageWidget, OrderedMarkerWidget, TableWidget } from './widgets'
import { isKnownNote } from './wikilinkComplete'
import { isComposing, compositionEnded } from './imeComposition'
import { isCursorInRange, caretInRange, activeLines, spansActiveLine } from './reveal'

const HIDE = Decoration.replace({})

// List-item line decoration (Obsidian-style structural hanging indent).
// The marker lives OUT of the text flow (absolutely positioned in a reserved
// gutter — see widgets + cmTheme), so the line reserves a content column via
// `padding-inline-start`. The padding applies to EVERY visual row, so wrapped
// rows align exactly under the first row's content — with no `ch` measurement
// of the marker glyph and no `text-indent` (avoids the rectangular-selection
// bug, discuss.codemirror#2881). The `slot` (marker gutter width) is sized PER
// MARKER TYPE so the marker→text gap is a tight ~0.5em for each, instead of one
// wide slot: bullet/checkbox use fixed em; ordered numbers size by digit count
// (left-aligned, so `1.`/`10.` start at the same x and content shifts). `STEP`
// is the per-nesting-level step. Exposes `--cm-list-pad` (content column) and
// `--cm-list-marker-left` (gutter offset the absolute marker reads).
const LIST_STEP = 1.6 // em — per nesting level
const BULLET_SLOT = '0.9em' // • (~0.4em) + ~0.5em gap
const TASK_SLOT = '1.5em' // checkbox (~1em) + ~0.5em gap
const listLineCache = new Map<string, Decoration>()
function listLine(level: number, markerClass: string, slot: string): Decoration {
  const key = `${level}:${markerClass}:${slot}`
  let d = listLineCache.get(key)
  if (!d) {
    const left = level * LIST_STEP
    d = Decoration.line({
      class: ('cm-list-line ' + markerClass).trim(),
      attributes: {
        style: `--cm-list-pad:calc(${left}em + ${slot});--cm-list-marker-left:${left}em`,
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
          ? isCursorInRange(state, parent.from, parent.to)
          : isCursorInRange(state, nf, nt)

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
          if (!isCursorInRange(state, nf, nt)) {
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
            // Ordered — structural: the number is rendered out-of-flow in the
            // gutter (right-aligned by CSS so `1.`/`10.` line up), content in the
            // reserved column. Caret on the marker → raw; a span selection keeps
            // it (same rule as bullets/tasks).
            if (caretInRange(state, nf, nt)) return
            const ln = state.doc.lineAt(nf)
            hide(ln.from, nf) // leading indent only; the widget replaces the `1. `
            // Slot sized to the number's digit count so it left-aligns with a
            // tight ~0.5ch gap; wider numbers shift their own content right.
            decos.push(listLine(listLevel(item), 'cm-list-ordered', `${nt - nf + 0.5}ch`).range(ln.from))
            const trailing = sliceOf(nt, nt + 1) === ' ' ? 1 : 0
            widget(nf, nt + trailing, Decoration.replace({ widget: new OrderedMarkerWidget(sliceOf(nf, nt)) }))
            return
          }
          const task = item?.getChild('Task')
          if (task) {
            // Task — structural, same gutter rules as bullets. Reveal region is
            // the `- [ ]` PREFIX (dash → marker end): a COLLAPSED caret there →
            // raw; a span selection does NOT reveal (Select-All keeps it). Editing
            // the task TEXT keeps the checkbox. Otherwise: hide the leading indent
            // (CSS reproduces it) + the `- `, and reserve the content column; the
            // TaskMarker handler drops the checkbox into the gutter.
            const marker = task.getChild('TaskMarker')
            const prefixEnd = marker?.to ?? task.to
            if (caretInRange(state, nf, prefixEnd)) return
            const ln = state.doc.lineAt(nf)
            hide(ln.from, nf)
            decos.push(listLine(listLevel(item), 'cm-list-task', TASK_SLOT).range(ln.from))
            hide(nf, sliceOf(nt, nt + 1) === ' ' ? nt + 1 : nt)
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
          if (caretInRange(state, nf, nt)) return
          const ln = state.doc.lineAt(nf)
          hide(ln.from, nf) // leading indent (no-op at top level); CSS reproduces it
          const trailing = sliceOf(nt, nt + 1) === ' ' ? 1 : 0
          hide(nf, nt + trailing) // the `- ` itself; bullet glyph comes from CSS
          decos.push(listLine(listLevel(item), 'cm-list-bullet', BULLET_SLOT).range(ln.from))
          return
        }
        if (name === 'TaskMarker') {
          const task = node.node.parent
          const checked = /[xX]/.test(sliceOf(nf, nt))
          // Completed-task styling persists regardless of reveal (Obsidian):
          // strike the whole task text. The mark spans the Task node; where the
          // `[x]` is replaced by the checkbox it just applies to the visible text.
          if (checked && task) mark(task.from, task.to, 'cm-task-checked')
          // Reveal region = the `- [ ]` prefix (dash → marker end). A COLLAPSED
          // caret there → raw; a span selection keeps the checkbox (matches the
          // bullet rule). Editing the task text keeps the checkbox.
          const dash = task?.parent?.getChild('ListMark')
          const from = dash?.from ?? nf
          if (caretInRange(state, from, nt)) return // caret on the prefix → raw
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
      if (!isCursorInRange(state, start, end)) {
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
