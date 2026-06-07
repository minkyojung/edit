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
import { ImageWidget, TableWidget } from './widgets'
import { isKnownNote } from './wikilinkComplete'
import { isComposing, compositionEnded } from './imeComposition'
import { isCursorInRange, caretInRange, activeLines, spansActiveLine } from './reveal'

const HIDE = Decoration.replace({})

// List-item layout — canonical CM6 "hanging indent" (CSS in cmTheme.ts). The line
// reserves the content column with `padding-inline-start` (= level*STEP + indent +
// gutter) and pulls ONLY the first visual row back by one gutter via a NEGATIVE
// `text-indent`. Because text-indent applies to the first row only, wrapped rows
// stay at the padding edge and align under the content automatically. Each marker
// fills that one-gutter (LIST_GUTTER) space and resets `text-indent:0` so the
// line's hang doesn't leak into the glyph. Markers stay IN-FLOW (the source text
// node survives, collapsed via CSS → IME composition anchor); the bullet/checkbox
// glyph is a ::before, the number is the visible source text.
const LIST_STEP = 1.6 // em — added per nesting level
const LIST_GUTTER = 1.5 // em — marker-column width. MUST equal the marker width +
// negative margin in cmTheme.ts (the marker hangs left by exactly this much).
const LIST_INDENT = 0.5 // em — base indent of the whole list from body text
const listLineCache = new Map<string, Decoration>()
function listLine(level: number): Decoration {
  const key = `${level}`
  let d = listLineCache.get(key)
  if (!d) {
    // Content column = nesting + base indent + one gutter. Wrapped rows and the
    // item content both sit here; the marker hangs one gutter left (CSS margin).
    const pad = level * LIST_STEP + LIST_INDENT + LIST_GUTTER
    d = Decoration.line({
      class: 'cm-list-line',
      attributes: { style: `--cm-list-pad:${pad}em` },
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

        // Lists. The marker renders structurally as an IN-FLOW widget in a fixed
        // gutter (the in-flow DOM node is the IME composition anchor). Reveal is
        // MARK-LEVEL (Obsidian): a COLLAPSED caret ON THE MARKER token (bullet/
        // number) or the `- [ ]` prefix (task) shows raw; editing the item's
        // CONTENT keeps the marker rendered. A span selection does NOT reveal.
        // Lists. The marker SOURCE text is kept (collapsed via CSS → IME anchor);
        // the visible marker is a gutter glyph (bullet/checkbox) or the visible
        // number. Reveal is MARK-LEVEL: a COLLAPSED caret on the marker token /
        // `- [ ]` prefix shows raw; editing CONTENT keeps it rendered.
        if (name === 'ListMark') {
          const item = node.node.parent
          const list = item?.parent
          const ln = state.doc.lineAt(nf)
          const level = listLevel(item)
          const trailing = sliceOf(nt, nt + 1) === ' ' ? 1 : 0
          if (list?.name === 'OrderedList') {
            if (caretInRange(state, nf, nt)) return // caret on the number → raw
            hide(ln.from, nf) // leading indent (no-op at top level)
            decos.push(listLine(level).range(ln.from))
            mark(nf, nt + trailing, 'cm-list-num') // visible number in the fixed gutter box
            return
          }
          const task = item?.getChild('Task')
          if (task) {
            const marker = task.getChild('TaskMarker')
            const prefixEnd = marker?.to ?? task.to
            if (caretInRange(state, nf, prefixEnd)) return // caret on `- [ ]` prefix → raw
            hide(ln.from, nf)
            decos.push(listLine(level).range(ln.from))
            mark(nf, nt + trailing, 'cm-list-taskdash') // collapse `- ` (no box); checkbox is the gutter
            return
          }
          // Bullet
          if (caretInRange(state, nf, nt)) return // caret on the dash → raw
          hide(ln.from, nf) // leading indent (no-op at top level)
          decos.push(listLine(level).range(ln.from))
          mark(nf, nt + trailing, 'cm-list-bullet') // • drawn in the fixed gutter box
          return
        }
        if (name === 'TaskMarker') {
          const task = node.node.parent
          const checked = /[xX]/.test(sliceOf(nf, nt))
          // Completed task: strike the whole task text (persists while editing).
          if (checked && task) mark(task.from, task.to, 'cm-task-checked')
          const dash = task?.parent?.getChild('ListMark')
          const from = dash?.from ?? nf
          if (caretInRange(state, from, nt)) return // caret on the `- [ ]` prefix → raw
          // MARK `[ ]` + trailing space into the fixed-width gutter box (text node
          // survives → IME; CSS collapses it and draws the box via ::before; the
          // box height keeps the caret normal). Click → taskCheckboxClick.
          const trailing = sliceOf(nt, nt + 1) === ' ' ? 1 : 0
          mark(nf, nt + trailing, checked ? 'cm-list-checkbox cm-list-checkbox-checked' : 'cm-list-checkbox')
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
    // IME: while composing, return the SAME decoration set (reference-identical),
    // NOT a recomputed or even re-mapped one. Handing CM a new DecorationSet
    // during composition makes it re-render the composition-adjacent DOM, which
    // WebKit treats as aborting the composition (duplicated/misplaced input —
    // CM6 progress blog; changelog 6.39.16). CM maps field decorations through
    // tr.changes itself at render time, so positions stay aligned. Rebuild once
    // when composition ends (compositionEnded). Matches mediaCards/highlights/
    // mermaidCards.
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

// The task checkbox is now a `mark` (not a widget), so there's no widget DOM to
// attach a click handler to. Toggle at the editor level: a click whose target is
// the `.cm-list-checkbox` span (its ::before box is what's visible) flips the
// status char `[ ]`↔`[x]`. `preventDefault` keeps the click from starting a
// selection; posAtDOM gives the `[` offset, +1 = the status char.
export const taskCheckboxClick: Extension = EditorView.domEventHandlers({
  mousedown(e, view) {
    const target = e.target as HTMLElement | null
    const box = target?.closest?.('.cm-list-checkbox') as HTMLElement | null
    if (!box) return false
    const ch = view.posAtDOM(box) + 1
    const cur = view.state.doc.sliceString(ch, ch + 1)
    if (cur !== ' ' && !/[xX]/.test(cur)) return false
    e.preventDefault()
    view.dispatch({ changes: { from: ch, to: ch + 1, insert: /[xX]/.test(cur) ? ' ' : 'x' } })
    return true
  },
})
