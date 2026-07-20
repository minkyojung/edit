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
import { Facet, type EditorState, type Line, type Range } from '@codemirror/state'
import { type SyntaxNode } from '@lezer/common'
import { isKnownNote } from '../wikilinkComplete'
import { inProofRawRange } from '@/editor/proofRawRanges'
import { cursorInRange } from './cursorRange'

const HIDE = Decoration.replace({})

// Whether a wikilink title resolves to a real note (drives blue vs red styling).
// Injectable so the dev prototypes keep the static stub while production (CmEditor)
// provides a real knownDocs-backed check. Last value wins; default = the stub.
export const wikilinkKnown = Facet.define<(title: string) => boolean, (title: string) => boolean>({
  combine: (values) => values[values.length - 1] ?? isKnownNote,
})

// Width (em) of the list marker column. The hanging-indent padding (JS, here) and
// the `.cm-list-marker` inline-block width (CSS, cmTheme) must be the SAME value so
// the marker fills its column and body text lands exactly at the column edge — so
// cmTheme imports this constant rather than re-hardcoding `1.8em` (single source,
// can't drift).
export const LIST_INDENT = 1.8

// Gap (em) between a list marker's glyph and the body text — the SINGLE shared
// value for bullet / number / task, so they line up identically (like Obsidian's
// `--list-bullet-end-padding`). Each marker positions its glyph `PAD` in from the
// column's right edge; before this the three were hand-tuned to different insets
// (0.32 / 0.15 / 0), which read as three different gaps. cmTheme imports this.
export const LIST_MARKER_END_PAD = 0.35

// Width (em) of the single source space after a marker (`- ` / `1. `). That space
// is a normal text glyph OUTSIDE the fixed `LIST_INDENT` marker column, so a
// wrapped/continuation line (which hangs at the column edge) would land ~one space
// left of the first line's body without it. Adding it to the line padding closes
// that gap. This is a constant approximation of the editor font's space advance
// (Obsidian uses the same trick via `--list-marker-space: 0.25em`); exact alignment
// would need per-line `coordsAtPos` measurement, which we deliberately avoid to keep
// the fixed-column design (no measure machinery, no reflow-on-remeasure bugs).
// It lives ONLY in the line inline-style — the `.cm-list-marker` column width is
// unchanged, so cmTheme needs no change.
export const LIST_MARKER_SPACE = 0.25

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

/** Context for a marker-LESS line that the syntax tree places inside a list item (a
 * hard-break / lazy-continuation line under a bullet). Walks up from the line start to
 * the innermost `ListItem` (nested → the child item, i.e. the deeper level), counts
 * ancestor `BulletList`/`OrderedList` for the `level` (the SAME rule the `ListMark`
 * branch uses so a real continuation lands at that line's body column), and measures
 * the item's `contentCol` — the character column where the item's content starts
 * (`indent + marker + gap`). `contentCol` is the CommonMark threshold that separates a
 * genuinely-indented continuation (>= contentCol → part of the item, hang it) from a
 * lazy continuation typed at/near the margin (< contentCol → the parser absorbs it but
 * the user wrote it flush, so DON'T yank it to the body column). `null` when the
 * position isn't inside a list item. */
function listItemContextAt(state: EditorState, pos: number): { level: number; contentCol: number } | null {
  let item: SyntaxNode | null = null
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === 'ListItem') {
      item = n
      break
    }
  }
  if (!item) return null
  let depth = 0
  for (let p: SyntaxNode | null = item.parent; p; p = p.parent) {
    if (p.name === 'BulletList' || p.name === 'OrderedList') depth++
  }
  // Content column = length of `indent + marker + gap` on the item's FIRST line. A
  // continuation is "really in the list" only when indented to at least this column.
  const itemLine = state.doc.lineAt(item.from)
  const cm = /^(\s*)([-*+]|\d+[.)])([ \t]+)/.exec(itemLine.text)
  const contentCol = cm ? cm[0].length : item.from - itemLine.from
  return { level: Math.max(0, depth - 1), contentCol }
}

/** Context for a continuation LINE, covering the one case listItemContextAt can't: a
 * WHITESPACE-ONLY continuation (what Shift+Enter leaves before you type). Lezer parses
 * such a line OUTSIDE the ListItem (verified: at Document level / in an uncovered gap),
 * so syntax-tree membership is not a reliable signal for it — we inherit the context
 * from the previous non-empty line, where the item is still open. `null` when neither
 * the line nor its predecessor sits in a list item. */
function listContinuationContextAt(state: EditorState, line: Line): { level: number; contentCol: number } | null {
  const direct = listItemContextAt(state, line.from)
  if (direct) return direct
  if (line.text.trim() !== '' || line.number <= 1) return null
  const prev = state.doc.line(line.number - 1)
  if (prev.length === 0) return null // a real blank line closed the item — not a continuation
  return listItemContextAt(state, prev.to - 1)
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
  // Whether the editor is FOCUSED. An unfocused editor has no active caret for
  // reveal purposes, so EVERY construct renders clean (Obsidian: a blurred pane
  // is fully rendered). Defaults true so headless tests keep caret-based reveal.
  focused = true,
): Range<Decoration>[] {
  const out: Range<Decoration>[] = []
  // Single reveal gate. A construct shows its raw markers only when the editor is
  // focused AND the caret touches [from, to]. Routing every branch (headings,
  // lists, quotes, tasks, inline marks) through this one predicate is what makes
  // an unfocused editor render uniformly clean.
  const caretIn = (from: number, to: number) => focused && cursorInRange(state, from, to)
  // Lines whose list marker the Lezer `ListMark` branch already styled, so the
  // immediate-marker fallback (after the tree walk) doesn't double-decorate once
  // the parser catches up a keystroke later.
  const listLinesDone = new Set<number>()
  const tree = syntaxTree(state)
  const mark = (from: number, to: number, cls: string) => {
    if (to > from) out.push(Decoration.mark({ class: cls }).range(from, to))
  }
  const hide = (from: number, to: number) => {
    if (to > from) out.push(HIDE.range(from, to))
  }
  // `edges` also tags the first/last line with `${cls}-first` / `${cls}-last`, so a
  // per-line-backgrounded block (code) can round its outer corners + pad top/bottom
  // and read as one card instead of stacked rectangles.
  const eachLineClass = (from: number, to: number, cls: string, edges = false) => {
    const first = state.doc.lineAt(from).number
    const last = state.doc.lineAt(Math.min(to, state.doc.length)).number
    for (let n = first; n <= last; n++) {
      let c = cls
      if (edges && n === first) c += ` ${cls}-first`
      if (edges && n === last) c += ` ${cls}-last`
      out.push(Decoration.line({ class: c }).range(state.doc.line(n).from))
    }
  }
  for (const { from, to } of ranges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const { name } = node
        const nf = node.from
        const nt = node.to

        // Pending AI proposal (Option B): leave it RAW so proposal ≠ content and
        // it edits natively. Skip the node + its children.
        if (inProofRawRange(state, nf)) return false

        // Images and GFM tables are owned ENTIRELY by the block-decoration layer
        // (v2/blocks): it replaces `![alt](url)` with the <img> widget and the whole
        // table with the editable-table widget (whose cells render their own inline
        // markdown via livePreviewInline). Without a guard here the inline layer ALSO
        // walks in and decorates their markers — an Image's `![`/`]`/`(`/`)` (which
        // Lezer labels with the SAME LinkMark/URL types a link uses) and any inline
        // markdown INSIDE table cells (`**bold**`, `[x](u)`, …). Two layers on one
        // block collide and leak stray markers around the rendered block. Skip the
        // node + children (return false) so blocks is the sole owner — same as the
        // proof guard above. (In inlineOnly cell mode the nested doc has no Image/
        // Table node, so this never suppresses a cell's own inline rendering.)
        if (name === 'Image' || name === 'Table') return false

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
          if (!caretIn(line.from, line.to)) {
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
          // Reveal the raw `(url)` only when the caret is inside THIS link's
          // span — not anywhere on the (line-wrapped) line. Without this, a
          // caret in a long bullet's text pops every link's URL on the line.
          const reveal = revealAll ?? caretIn(p!.from, p!.to)
          if (!reveal) hide(nf, nt)
          return
        }
        if (
          name === 'EmphasisMark' ||
          name === 'StrikethroughMark' ||
          name === 'CodeMark' ||
          name === 'LinkMark'
        ) {
          // PER-CONSTRUCT reveal: a marker shows raw only when the caret is inside
          // its OWN construct (Emphasis / StrongEmphasis / Strikethrough / InlineCode
          // / Link) — the marker's parent node — NOT anywhere on the (possibly long,
          // wrapped) line. This is the Obsidian rule and matches the per-link fix; it
          // stops a caret in a long bullet's prose from popping every `**`/`` ` ``/URL
          // on the line raw. IME safety is NOT provided by line-level reveal anymore —
          // it comes from the composing-freeze (the plugin maps, never recomputes,
          // decorations while view.composing) plus @codemirror/view ≥6.39.16.
          // A wikilink's inner `[`/`]` are LinkMarks of a Link — leave them to the
          // regex overlay so the two layers don't both hide them with split gates.
          const p = node.node.parent
          if (name === 'LinkMark' && p?.name === 'Link' && isWikiLink(state, p.from, p.to)) return
          const line = state.doc.lineAt(nf)
          const rFrom = p ? p.from : line.from
          const rTo = p ? p.to : line.to
          const reveal = revealAll ?? caretIn(rFrom, rTo)
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
          if (!caretIn(line.from, line.to)) {
            const trailing = state.doc.sliceString(nt, nt + 1) === ' ' ? 1 : 0
            hide(nf, nt + trailing)
          }
          return
        }

        // Horizontal rule — render as a ruled line (cm-hr hides the text + draws a
        // border) unless the caret is on the line, then show raw `---`.
        if (name === 'HorizontalRule') {
          const line = state.doc.lineAt(nf)
          if (!caretIn(line.from, line.to)) {
            out.push(Decoration.line({ class: 'cm-hr' }).range(line.from))
          }
          return
        }

        // Fenced code — style every line (fences stay visible; mono looks fine).
        // No reveal toggle.
        if (name === 'FencedCode') {
          eachLineClass(nf, nt, 'cm-code-block', true)
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
          listLinesDone.add(line.from)
          out.push(
            Decoration.line({
              class: 'cm-list-line',
              attributes: {
                style: `padding-left:${(level + 1) * LIST_INDENT + LIST_MARKER_SPACE}em;text-indent:-${LIST_INDENT + LIST_MARKER_SPACE}em`,
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
              const revealed = caretIn(nf, markerTo) // caret on `- [ ]` → raw
              mark(
                nf,
                markerTo,
                revealed
                  ? 'cm-list-marker'
                  : `cm-list-marker cm-task-marker${checked ? ' cm-task-marker-checked' : ''}`,
              )
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
          // Number is its own glyph (just tinted) → always shown. Bullet hides its
          // dash and draws a •, unless the caret is on it (then raw). Either way the
          // `.cm-list-marker` column stays, so the body never shifts on reveal.
          if (isNum) return void mark(nf, nt, 'cm-list-marker cm-list-num')
          mark(nf, nt, caretIn(nf, nt) ? 'cm-list-marker' : 'cm-list-marker cm-list-bullet')
          return
        }
      },
    })

    // Wikilinks `[[Title]]` — not (cleanly) in the markdown grammar, so a regex
    // overlay over the same range. Mark the inner title (broken-styled if unknown)
    // and hide `[[`/`]]` unless the caret is inside THIS wikilink — per-construct
    // reveal, same as every other inline construct, so a caret elsewhere on the
    // (long, wrapped) line no longer pops the brackets raw. IME safety comes from
    // the composing-freeze + @codemirror/view ≥6.39.16, not line-level reveal.
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
      if (revealAll ?? caretIn(start, end)) {
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

    // Immediate list markers — the Lezer `ListMark`/`BulletList` node only forms
    // once the item has content, so a just-typed `- ` / `1. ` stays raw until the
    // parser catches up a keystroke later (its own comment notes this for tasks).
    // Decorate any list-shaped line the tree walk didn't already cover, so the
    // bullet / number appears on the keystroke — mirrors the task-marker regex
    // trick above. Marks only (no replace) → IME-safe, same as the Lezer path.
    if (!inlineOnly) {
      const firstLine = state.doc.lineAt(from).number
      const lastLine = state.doc.lineAt(Math.min(to, state.doc.length)).number
      for (let ln = firstLine; ln <= lastLine; ln++) {
        const line = state.doc.line(ln)
        if (listLinesDone.has(line.from)) continue // Lezer already styled this line
        const lm = /^(\s*)([-*+]|\d+[.)])\s/.exec(line.text)
        if (!lm) {
          // No marker — a continuation line of the list item above (incl. the empty one
          // Shift+Enter just made). Hang it at the item's body column so the first row
          // and every wrapped row align under the content.
          if (line.from === line.to) continue // truly blank line (paragraph break) — skip
          if (inCodeContext(state, line.from)) continue // literal code line in a list
          const ctx = listContinuationContextAt(state, line)
          if (ctx == null) continue
          // Only a continuation ACTUALLY indented to the item's content column belongs to
          // the list. A flush-left / under-indented line is a CommonMark lazy continuation
          // the parser folds in, but the user typed it at the margin — leave it there.
          // This is what keeps the paragraph below a list from jumping right on a keystroke.
          const ws = line.text.length - line.text.trimStart().length
          if (ws < ctx.contentCol) continue
          // The line's own `ws` leading spaces render, so pull the first visual row back
          // by their EXACT width — `ws × --cm-space-w` (measured, see spaceWidthProbe).
          // Net: the first row's text and every wrapped row (and the caret on an empty
          // line) land at the body column, with no space-advance guess. Line-decoration
          // only → IME-safe. Falls back to the 0.25em estimate before the measure lands.
          out.push(
            Decoration.line({
              class: 'cm-list-line',
              attributes: {
                style: `padding-left:${(ctx.level + 1) * LIST_INDENT + LIST_MARKER_SPACE}em;text-indent:calc(${ws} * var(--cm-space-w, 0.25em) * -1)`,
              },
            }).range(line.from),
          )
          continue
        }
        // Horizontal rule vs empty bullet: a real HR is 3+ of `-`/`*`/`_` (CommonMark);
        // a lone `- ` / `* ` is an EMPTY BULLET, not a rule. The old `/^[-*_ ]+$/`
        // matched a single `-` too, so it wrongly skipped empty bullets — which the
        // Lezer tree ALSO can't render below a different-type list (it's parsed as lazy
        // continuation), so the marker never appeared until content was typed. Require
        // 3+ rule chars so `---`/`* * *` still skip but `- `/`* ` render as bullets.
        const trimmed = line.text.trim()
        if (/^[-*_ ]+$/.test(trimmed) && (trimmed.match(/[-*_]/g)?.length ?? 0) >= 3) continue
        if (inCodeContext(state, line.from)) continue // `- ` inside a code fence is literal
        const indent = lm[1].length
        const markerFrom = line.from + indent
        const markerTo = markerFrom + lm[2].length
        const isNum = /\d/.test(lm[2])
        // Hanging indent — match the ListMark branch so the body doesn't shift when
        // Lezer catches up. Depth from indentation (exact for top level; transient).
        const level = Math.floor(indent / 2)
        out.push(
          Decoration.line({
            class: 'cm-list-line',
            attributes: {
              style: `padding-left:${(level + 1) * LIST_INDENT + LIST_MARKER_SPACE}em;text-indent:-${LIST_INDENT + LIST_MARKER_SPACE}em`,
            },
          }).range(line.from),
        )
        const tm = isNum ? null : /^ \[([ xX])\]/.exec(state.doc.sliceString(markerTo, markerTo + 4))
        if (tm) {
          const taskTo = markerTo + 4
          const checked = /[xX]/.test(tm[1])
          mark(
            markerFrom,
            taskTo,
            caretIn(markerFrom, taskTo)
              ? 'cm-list-marker'
              : `cm-list-marker cm-task-marker${checked ? ' cm-task-marker-checked' : ''}`,
          )
        } else if (isNum) {
          mark(markerFrom, markerTo, 'cm-list-marker cm-list-num')
        } else {
          mark(
            markerFrom,
            markerTo,
            caretIn(markerFrom, markerTo)
              ? 'cm-list-marker'
              : 'cm-list-marker cm-list-bullet',
          )
        }
      }
    }
  }
  return out
}

function previewPlugin(inlineOnly: boolean) {
  return ViewPlugin.fromClass(
    class {
      deco: DecorationSet
      // step 2c — IME composition freeze. While the user is composing (IME), DON'T
      // rebuild decorations: feeding a different decoration set to the core mid-
      // composition forces it to re-render the composing line's DOM, which corrupts
      // the in-progress composition (the "typed then snaps back" flicker). Instead we
      // map the existing decos through the edit (positions only) and stay frozen until
      // composition ends, then do one full rebuild. This is exactly how CodeMirror's
      // own `bracketMatching` (@codemirror/language) handles it. `paused` forces that
      // final rebuild on the first update after composing goes false (view.composing
      // can linger true for a tick, so we can't rely on a clean trailing event).
      paused = false
      constructor(view: EditorView) {
        this.deco = this.build(view)
      }
      build(view: EditorView): DecorationSet {
        // Cell mode reveals by focus (a single-line cell is always "on its line").
        const revealAll = inlineOnly ? view.hasFocus : undefined
        return Decoration.set(
          buildDecos(view.state, view.visibleRanges, inlineOnly, revealAll, view.hasFocus),
          true,
        )
      }
      update(u: ViewUpdate) {
        // Reveal depends on selection AND focus (a blurred main editor renders fully
        // clean), so rebuild on both — not just the cell variant.
        if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || this.paused) {
          if (u.view.composing) {
            this.deco = this.deco.map(u.changes)
            this.paused = true
          } else {
            this.deco = this.build(u.view)
            this.paused = false
          }
        }
      }
    },
    { decorations: (v) => v.deco },
  )
}

export const livePreviewV2 = previewPlugin(false)
// Inline-only variant for table cells (no block constructs — see `inlineOnly`).
export const livePreviewInline = previewPlugin(true)

// Test-only: the pure decoration builder, so reveal behavior can be asserted
// headlessly (the ViewPlugin's composing-freeze needs a real browser).
export { buildDecos as _buildDecos, HIDE as _HIDE }

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
