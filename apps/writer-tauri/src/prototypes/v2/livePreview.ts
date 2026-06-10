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
import { Facet, type EditorState, type Range } from '@codemirror/state'
import { type SyntaxNode } from '@lezer/common'
import { isKnownNote } from '../wikilinkComplete'

const HIDE = Decoration.replace({})

// Whether a wikilink title resolves to a real note (drives blue vs red styling).
// Injectable so the dev prototypes keep the static stub while production (CmEditor)
// provides a real knownDocs-backed check. Last value wins; default = the stub.
export const wikilinkKnown = Facet.define<(title: string) => boolean, (title: string) => boolean>({
  combine: (values) => values[values.length - 1] ?? isKnownNote,
})

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

/** lezer parses `[[Title]]` as a `Link` ([Title]) wrapped in an extra `[`…`]`.
 * Detect that so the grammar Link/LinkMark handling can bail and leave wikilinks
 * entirely to the regex overlay (otherwise both fire → double styling, overlapping
 * hides, and split reveal gates). */
function isWikiLink(state: EditorState, from: number, to: number): boolean {
  return state.doc.sliceString(from - 1, from) === '[' && state.doc.sliceString(to, to + 1) === ']'
}

/** Inside an inline or fenced code context → text is literal (don't apply the
 * wikilink regex overlay there). Node names: InlineCode, FencedCode, CodeText… */
function inCodeContext(state: EditorState, pos: number): boolean {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (/Code/.test(n.name)) return true
  }
  return false
}

function buildDecos(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
  inlineOnly = false,
  // Cell mode: when defined, reveal is decided by FOCUS, not the active line —
  // a single-line cell's caret is always "on its line", so active-line reveal would
  // never render. true = focused → show raw; false = blurred → render. undefined =
  // main editor's active-line behavior.
  revealAll?: boolean,
): Range<Decoration>[] {
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

        // INLINE-ONLY mode (table cells): a GFM table cell holds inline content
        // only — there are no real headings/lists/quotes/rules/code-blocks in a
        // cell. Skip those block branches (return undefined → still descend so
        // inline marks INSIDE them, e.g. bold, render); the block markers stay raw.
        if (
          inlineOnly &&
          (/^ATXHeading[1-6]$/.test(name) ||
            name === 'HeaderMark' ||
            name === 'Blockquote' ||
            name === 'QuoteMark' ||
            name === 'HorizontalRule' ||
            name === 'FencedCode' ||
            name === 'ListMark')
        ) {
          return undefined
        }

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
        // Skip `[[wikilinks]]` (parsed as a Link too) — the regex overlay owns them.
        if (name === 'Link') {
          if (isWikiLink(state, nf, nt)) return
          return void mark(nf, nt, 'cm-link')
        }
        // URL nodes are TWO different things: the `(url)` destination of a
        // `[text](url)` link (hideable — the text stays), OR a GFM bare autolink
        // `https://…` which IS the only visible content (hiding it erases the line).
        // Distinguish by whether a `[text](` precedes it inside a Link.
        if (name === 'URL') {
          const p = node.node.parent
          if (p?.name === 'Link' && isWikiLink(state, p.from, p.to)) return // overlay owns wikilinks
          const isDestination = p?.name === 'Link' && p.from < nf // a `[text](` sits before the url
          if (!isDestination) return void mark(nf, nt, 'cm-link') // bare autolink — style, never hide
          const line = state.doc.lineAt(nf)
          const reveal = revealAll ?? cursorInRange(state, line.from, line.to)
          if (!reveal) hide(nf, nt)
          return
        }
        if (
          name === 'EmphasisMark' ||
          name === 'StrikethroughMark' ||
          name === 'CodeMark' ||
          name === 'LinkMark'
        ) {
          // A wikilink's inner `[`/`]` are LinkMarks of a Link — leave them to the
          // regex overlay so the two layers don't both hide them with split gates.
          if (name === 'LinkMark') {
            const p = node.node.parent
            if (p?.name === 'Link' && isWikiLink(state, p.from, p.to)) return
          }
          // Cell mode (revealAll defined) → reveal by focus. Else ACTIVE-LINE reveal:
          // show the WHOLE line raw when the selection touches it (the IME-safe rule —
          // the composing line never carries a replace decoration).
          const line = state.doc.lineAt(nf)
          const reveal = revealAll ?? cursorInRange(state, line.from, line.to)
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
              // Fold the space after `]` out of the render (same reason/gate as the
              // bullet/number branch below) so the body lands at the column edge on
              // every line. The marker box range (nf..markerTo) is untouched, so
              // `coordsAtPos(markerTo)` — the checkbox click hit-test anchor — is
              // unaffected.
              if (!cursorInRange(state, line.from, line.to) && state.doc.sliceString(markerTo, markerTo + 1) === ' ')
                hide(markerTo, markerTo + 1)
              // Completed task → strike + mute the body (kept while editing, like
              // Obsidian). Start at the first non-space AFTER the marker so the
              // strike doesn't run through the gap between the checkbox and the text.
              if (checked) {
                const gapLen = /^[ \t]*/.exec(state.doc.sliceString(markerTo, line.to))?.[0].length ?? 0
                mark(markerTo + gapLen, line.to, 'cm-task-done')
              }
              return
            }
          }
          if (state.doc.sliceString(nt, nt + 1) !== ' ') return // `- `/`1. ` only
          const isNum = item?.parent?.name === 'OrderedList'
          // Fold the marker's trailing space (nt..nt+1) OUT of the render so body
          // text starts at the column edge on EVERY line. That space is a real char:
          // left in the flow it only indents the FIRST line, so wrapped lines hang one
          // space-width too far left. This is a render-only replace (doc unchanged) and
          // is gated LINE-level (caret off the line) — never leave a replace beside a
          // composing IME caret — exactly like the heading/wikilink hides above.
          if (!cursorInRange(state, line.from, line.to)) hide(nt, nt + 1)
          // Number is its own glyph (just tinted) → always shown. Bullet hides its
          // dash and draws a •, unless the caret is on it (then raw). Either way the
          // `.cm-list-marker` column stays, so the body never shifts on reveal.
          if (isNum) return void mark(nf, nt, 'cm-list-marker cm-list-num')
          mark(nf, nt, cursorInRange(state, nf, nt) ? 'cm-list-marker' : 'cm-list-marker cm-list-bullet')
          return
        }
      },
    })

    // Wikilinks `[[Title]]` — not (cleanly) in the markdown grammar, so a regex
    // overlay over the same range. Mark the inner title (broken-styled if unknown)
    // and hide `[[`/`]]` unless the caret is on the LINE — line-level reveal, same
    // as every other construct, so a composing caret elsewhere on the line never
    // leaves a `[[`/`]]` replace decoration on it (IME safety).
    const text = state.doc.sliceString(from, to)
    const re = /\[\[([^\]\n]+)\]\]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const start = from + m.index
      if (inCodeContext(state, start)) continue // `[[...]]` inside `code` is literal
      const innerFrom = start + 2
      const innerTo = innerFrom + m[1].length
      const end = innerTo + 2
      // Obsidian model: the TITLE is always the link (blue underline / red broken).
      mark(innerFrom, innerTo, state.facet(wikilinkKnown)(m[1]) ? 'cm-wikilink' : 'cm-wikilink-broken')
      const line = state.doc.lineAt(start)
      if (revealAll ?? cursorInRange(state, line.from, line.to)) {
        // editing → SHOW the `[[`/`]]` brackets, just muted (a class, not a replace,
        // so the composing caret's line never carries a replace → IME-safe).
        mark(start, innerFrom, 'cm-wikilink-bracket')
        mark(innerTo, end, 'cm-wikilink-bracket')
      } else {
        // rendered → hide the brackets entirely (just the styled title shows).
        hide(start, innerFrom)
        hide(innerTo, end)
      }
    }
  }
  return out
}

function previewPlugin(inlineOnly: boolean) {
  return ViewPlugin.fromClass(
    class {
      deco: DecorationSet
      constructor(view: EditorView) {
        this.deco = this.build(view)
      }
      build(view: EditorView): DecorationSet {
        // Cell mode reveals by focus (a single-line cell is always "on its line").
        const revealAll = inlineOnly ? view.hasFocus : undefined
        return Decoration.set(buildDecos(view.state, view.visibleRanges, inlineOnly, revealAll), true)
      }
      update(u: ViewUpdate) {
        // Reveal depends on selection (main) or focus (cell), so rebuild on both.
        if (u.docChanged || u.viewportChanged || u.selectionSet || (inlineOnly && u.focusChanged))
          this.deco = this.build(u.view)
      }
    },
    { decorations: (v) => v.deco },
  )
}

export const livePreviewV2 = previewPlugin(false)
// Inline-only variant for table cells (no block constructs — see `inlineOnly`).
export const livePreviewInline = previewPlugin(true)

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
