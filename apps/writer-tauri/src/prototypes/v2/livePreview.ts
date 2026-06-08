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

// Width (em) of the list marker column. The hanging-indent padding (JS, here) and
// the `.cm-list-marker` inline-block width (CSS, cmTheme) MUST match this value so
// the marker fills its column and body text lands exactly at the column edge.
const LIST_INDENT = 1.8

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

        // Emphasis / inline code — keep the STYLING mark on the text regardless;
        // the marker hiding is decided per-LINE below.
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
          // ACTIVE-LINE reveal (not per-construct). Show the WHOLE line raw when the
          // selection touches it — exactly like headings/quotes below, and like
          // Obsidian. This is the fundamental IME fix: the line the caret (and thus
          // an IME composition) is on never carries a replace decoration, so CJK
          // composition can never be disturbed. Other lines hide markers as before.
          const line = state.doc.lineAt(nf)
          if (!cursorInRange(state, line.from, line.to)) hide(nf, nt)
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

        // List markers — ONE branch, shared gate + reveal; only the class differs
        // by kind. Bullet `-` is hidden and a • is drawn over it (visibility:hidden
        // + ::after). The ordered number is its own glyph, so it's just styled
        // (color) — no hiding. Both occupy the same box as the raw marker, so the
        // reveal toggle never reflows (no caret lag). Task markers are step 5.
        if (name === 'ListMark') {
          const item = node.node.parent
          // Hanging indent — give EVERY list line a fixed marker column (LIST_INDENT
          // em). The marker (`.cm-list-marker`) is an inline-block of exactly that
          // width, so bullets, numbers and tasks all start their body text at the
          // SAME x, and a wrapped line continues under that text instead of falling
          // back under the marker. `padding-left` reserves the column(s); a matching
          // negative `text-indent` pulls the first line's marker back into the first
          // column. Nested lists add one column per level.
          let depth = 0
          for (let p = item?.parent; p; p = p.parent) {
            if (p.name === 'BulletList' || p.name === 'OrderedList') depth++
          }
          const level = Math.max(0, depth - 1)
          const line = state.doc.lineAt(nf)
          out.push(
            Decoration.line({
              attributes: {
                style: `padding-left:${(level + 1) * LIST_INDENT}em;text-indent:-${LIST_INDENT}em`,
              },
            }).range(line.from),
          )

          // Task `- [ ] ` → draw a checkbox over the `- [ ]` prefix. Detect by the
          // text after the dash (regex), NOT the lezer `Task` node (which only forms
          // once the item has content → a keystroke late). OVERLAY, not replace: the
          // marker box is the fixed-width `.cm-list-marker`, and the checkbox is a
          // position:absolute ::after on `.cm-task-marker` (out of flow → no reflow,
          // no paint lag). The fixed column also pins the box and body regardless of
          // `[ ]` vs `[x]` width, so the old per-char monospace hack is gone.
          if (item?.parent?.name === 'BulletList') {
            const tm = /^ \[([ xX])\]/.exec(state.doc.sliceString(nt, nt + 4))
            if (tm) {
              const markerTo = nt + 4 // after `]`
              const checked = /[xX]/.test(tm[1])
              const revealed = cursorInRange(state, nf, markerTo) // caret on `- [ ]` → raw
              mark(
                nf,
                markerTo,
                revealed
                  ? 'cm-list-marker'
                  : `cm-list-marker cm-task-marker${checked ? ' cm-task-marker-checked' : ''}`,
              )
              // Completed task → strike + mute the body (kept while editing, like Obsidian).
              if (checked) mark(markerTo, line.to, 'cm-task-done')
              return
            }
          }
          if (state.doc.sliceString(nt, nt + 1) !== ' ') return // `- `/`1. ` only
          const isNum = item?.parent?.name === 'OrderedList'
          // Number is its own glyph (just tinted) → always shown. Bullet hides its
          // dash and draws a •, unless the caret is on it (then raw). Either way the
          // `.cm-list-marker` column stays, so the body never shifts on reveal.
          if (isNum) return void mark(nf, nt, 'cm-list-marker cm-list-num')
          mark(nf, nt, cursorInRange(state, nf, nt) ? 'cm-list-marker' : 'cm-list-marker cm-list-bullet')
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

// Click the drawn checkbox → toggle `[ ]`↔`[x]`. The box is a CSS `::after`
// pseudo-element, so it can't be an event target. Instead we hit-test the click
// against the box's rect — derived from the marker's end coordinate (the right
// edge of the hidden `- [ ]`) plus the known CSS geometry (right:0.15em, 1.05em
// square, vertically centred) — at the editor level, which always receives the
// event. ONLY a hit inside the box toggles; anything else falls through to normal
// caret placement, so "box only" is honoured. Toggling = a 1-char doc change
// (text is the source of truth); the decoration re-renders the box from it.
const TASK_RE = /^(\s*[-*+] \[)([ xX])\]/
export const taskCheckboxClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0) return false
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
    if (pos == null) return false
    const line = view.state.doc.lineAt(pos)
    const m = TASK_RE.exec(line.text)
    if (!m) return false
    const markerStart = line.from + (m[1].length - 3) // the `-`
    const markerTo = line.from + m[0].length // just after `]`
    if (cursorInRange(view.state, markerStart, markerTo)) return false // revealed → no box
    const end = view.coordsAtPos(markerTo) // right edge of the hidden marker
    if (!end) return false
    const fs = parseFloat(getComputedStyle(view.contentDOM).fontSize) || 16
    const boxRight = end.left - 0.15 * fs
    const boxLeft = boxRight - 1.05 * fs
    const cy = (end.top + end.bottom) / 2
    const halfH = 0.525 * fs + 2 // +2px vertical tolerance
    if (event.clientX < boxLeft || event.clientX > boxRight) return false
    if (event.clientY < cy - halfH || event.clientY > cy + halfH) return false
    event.preventDefault()
    const statusPos = line.from + m[1].length // the space / `x`
    view.dispatch({ changes: { from: statusPos, to: statusPos + 1, insert: /[xX]/.test(m[2]) ? ' ' : 'x' } })
    return true
  },
})
