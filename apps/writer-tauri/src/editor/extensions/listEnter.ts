// Deterministic list Enter — the canonical pattern from kenforthewin/atomic-editor
// (`insertTightListItem`, bound at Prec.highest). CM's built-in
// `insertNewlineContinueMarkup` infers a list's loose/tight nature from the syntax
// tree and, when it guesses "loose", inserts a blank line as part of the
// continuation — which bleeds in unpredictably (timing/IME) and corrupts list
// editing. We compute everything from the current line text instead, so the result
// is ALWAYS the same:
//   • empty item  → exit cleanly (nested: outdent one level; top-level: clear line)
//   • filled item → continue TIGHT (same-kind marker, no blank line)
//   • not a list  → return false so the caller falls back (quotes / plain newline)
//
// MUST be bound at Prec.highest so it beats any other Enter handler.

import { EditorView } from '@codemirror/view'
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown'
import { insertNewlineAndIndent } from '@codemirror/commands'
import { inCodeBlock } from './slashCommands'

// indent | marker(bullet or `N.`/`N)`) | gap | optional task box | content
const LIST_RE = /^(\s*)([-*+]|\d+[.)])([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/
const INDENT_UNIT = '  ' // matches indentUnit.of('  ')

export function listEnter(view: EditorView): boolean {
  const { state } = view
  const sel = state.selection.main
  if (!sel.empty) return false // a real selection → let default replace it
  const line = state.doc.lineAt(sel.head)
  const m = LIST_RE.exec(line.text)
  if (!m) return false
  const [, indent, marker, gap, task, content] = m

  // Empty item → exit. Nested items outdent one level first; top-level clears.
  if (content.trim() === '') {
    if (indent.length >= INDENT_UNIT.length) {
      const dedented = indent.slice(0, indent.length - INDENT_UNIT.length) + marker + gap + (task ? '[ ] ' : '')
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: dedented },
        selection: { anchor: line.from + dedented.length },
        scrollIntoView: true,
        userEvent: 'delete.dedent',
      })
    } else {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: '' },
        selection: { anchor: line.from },
        scrollIntoView: true,
        userEvent: 'delete',
      })
    }
    return true
  }

  // Filled item → continue tight. Ordered marker increments; bullet stays; a task
  // continues as a fresh unchecked box. Text after the caret moves down (a mid-line
  // Enter splits the item, same as the built-in).
  const ordered = /^(\d+)([.)])$/.exec(marker)
  const nextMarker = ordered ? `${parseInt(ordered[1], 10) + 1}${ordered[2]}` : marker
  const insert = '\n' + indent + nextMarker + gap + (task ? '[ ] ' : '')
  view.dispatch({
    changes: { from: sel.head, to: sel.head, insert },
    selection: { anchor: sel.head + insert.length },
    scrollIntoView: true,
    userEvent: 'input',
  })
  return true
}

/**
 * Shift+Enter inside a list = continue the SAME item on a new line, INDENTED to the
 * item's content column, so the continuation is a real CommonMark part of the item
 * rather than a flush-left lazy continuation that renders at the margin (livePreview
 * only hangs a continuation indented to at least `indent + marker + gap`). On a marker
 * line we indent to that column (task box excluded, matching livePreview's contentCol);
 * on an already-indented line we mirror its indent so a third/fourth continuation stays
 * aligned. A flush-left, non-list line returns false → the caller falls back to a plain
 * soft newline. Text-based (like listEnter) so it never lags the parser.
 */
export function continueListItemSoft(view: EditorView): boolean {
  const { state } = view
  const sel = state.selection.main
  if (!sel.empty) return false // a real selection → let default replace it
  const line = state.doc.lineAt(sel.head)
  let indentStr: string | null = null
  const m = LIST_RE.exec(line.text)
  if (m) {
    const [, indent, marker, gap] = m
    indentStr = ' '.repeat(indent.length + marker.length + gap.length)
  } else {
    const lead = /^[ \t]*/.exec(line.text)![0]
    if (lead.length > 0) indentStr = lead // continuation of an already-indented block
  }
  if (indentStr == null) return false // flush-left non-list line → plain newline
  const insert = '\n' + indentStr
  view.dispatch({
    changes: { from: sel.head, to: sel.head, insert },
    selection: { anchor: sel.head + insert.length },
    scrollIntoView: true,
    userEvent: 'input',
  })
  return true
}

/**
 * Enter on a marker-LESS line that belongs to a list item (an indented continuation,
 * the kind Shift+Enter creates). Obsidian's UX, which stock CM never does (its
 * `insertNewlineContinueMarkup` only re-indents the paragraph there, by design):
 *   • continuation WITH content → start a NEW item of the same list at the same level
 *     (same marker kind, ordered +1, task box fresh — identical to listEnter's rules);
 *   • WHITESPACE-ONLY continuation → exit the list: clear the indent, caret column 0
 *     (mirrors listEnter's empty-top-level-item exit).
 * Text-based like listEnter (never lags the parser): the governing item is found by
 * scanning upward past indented lines to the nearest marker line; a blank or flush-left
 * line ends the item, and an under-indented current line (lazy continuation the user
 * typed at the margin) is NOT ours — matches livePreview's rendering gate.
 */
export function continuationEnter(view: EditorView): boolean {
  const { state } = view
  const sel = state.selection.main
  if (!sel.empty) return false
  const line = state.doc.lineAt(sel.head)
  if (LIST_RE.test(line.text)) return false // marker line → listEnter's job
  const ws = /^[ \t]*/.exec(line.text)![0].length
  if (ws === 0) return false // flush-left → not a list continuation
  // Find the governing marker line: walk up while lines look like continuations.
  let m: RegExpExecArray | null = null
  for (let n = line.number - 1; n >= 1; n--) {
    const prev = state.doc.line(n)
    if (prev.length === 0) return false // blank line closed the list
    m = LIST_RE.exec(prev.text)
    if (m) break
    if (/^[ \t]*/.exec(prev.text)![0].length === 0) return false // flush-left non-marker
  }
  if (!m) return false
  const [, indent, marker, gap, task] = m
  const contentCol = indent.length + marker.length + gap.length

  // Whitespace-only continuation → exit the list (clear indent, caret col 0).
  if (ws === line.text.length) {
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: '' },
      selection: { anchor: line.from },
      scrollIntoView: true,
      userEvent: 'delete',
    })
    return true
  }

  if (ws < contentCol) return false // lazy continuation typed at the margin → not ours
  // Continuation with content → new item of the same list (same rules as listEnter).
  const ordered = /^(\d+)([.)])$/.exec(marker)
  const nextMarker = ordered ? `${parseInt(ordered[1], 10) + 1}${ordered[2]}` : marker
  const insert = '\n' + indent + nextMarker + gap + (task ? '[ ] ' : '')
  view.dispatch({
    changes: { from: sel.head, to: sel.head, insert },
    selection: { anchor: sel.head + insert.length },
    scrollIntoView: true,
    userEvent: 'input',
  })
  return true
}

/**
 * The full Enter behaviour for the editor (and the IME-recovery path). Order:
 *  1. listEnter — deterministic tight list continuation / clean exit (marker lines).
 *  2. continuationEnter — Obsidian-style Enter on an indented continuation line:
 *     new same-level item (content) or list exit (whitespace-only).
 *  3. blockquote (`>`) ONLY → CM's markup-continue (it handles quote continuation
 *     fine). We gate it to quote lines because `insertNewlineContinueMarkup`
 *     MIS-handles a lazy-continuation line SHORTER than the marker width — its
 *     emptyLine check slices the line at the marker column, gets "", and the
 *     empty-item path deletes the typed text (verified live on 6.5.0; the borrowed
 *     marker-line columns are the package's historically buggy zone, cf. changelog
 *     0.17.2 / 0.18.2 / 6.1.1 / 6.5.1). So for any non-list, non-quote line we use
 *     a plain newline instead.
 *  4. plain newline (with indent maintenance for code blocks).
 */
// Shared dedupe signal for the two Enter paths (keymap on keydown, imeListContinue
// on beforeinput). Whenever smartEnter actually handles an Enter it stamps the
// time; the beforeinput path skips if smartEnter ran just now (same Enter the
// keymap already took). One source of truth → no dual-timer boundary race where an
// Enter fires twice or zero times.
let lastEnterHandledAt = -1
export function enterHandledRecently(ms = 50): boolean {
  return lastEnterHandledAt >= 0 && performance.now() - lastEnterHandledAt < ms
}

export function smartEnter(view: EditorView): boolean {
  const { state } = view
  const sel = state.selection.main
  // Inside a fenced/indented code block, a `- x` or `> x` line is LITERAL code, not a
  // list/quote — the three continuation commands below are pure line-text regex with
  // no tree awareness, so without this guard Enter would inject a `- `/`N.` marker into
  // the code (silent content corruption). Fall straight to a plain newline, which also
  // maintains code-block indentation. (Same tree guard the Backspace/slash paths use.)
  if (inCodeBlock(state, sel.head)) {
    const handled = insertNewlineAndIndent(view)
    if (handled) lastEnterHandledAt = performance.now()
    return handled
  }
  let handled = listEnter(view) || continuationEnter(view)
  if (!handled) {
    const line = state.doc.lineAt(sel.head)
    handled = /^\s*>/.test(line.text) ? insertNewlineContinueMarkup(view) : insertNewlineAndIndent(view)
  }
  if (handled) lastEnterHandledAt = performance.now()
  return handled
}

/**
 * The full Shift+Enter behaviour (and its IME-recovery path): continue a list item on
 * an INDENTED new line (a real continuation), else a plain soft newline. Stamps the
 * SAME `lastEnterHandledAt` signal as smartEnter so the `beforeinput` IME path dedupes
 * against the keymap — one source of truth, no double / dropped line break.
 */
export function shiftEnter(view: EditorView): boolean {
  const { state } = view
  // In code, continue with CM's indentation-aware newline rather than the list-item
  // soft continuation (which would indent to a marker's content column). Consistent
  // with smartEnter's guard above.
  if (inCodeBlock(state, state.selection.main.head)) {
    const handled = insertNewlineAndIndent(view)
    if (handled) lastEnterHandledAt = performance.now()
    return handled
  }
  let handled = continueListItemSoft(view)
  if (!handled) handled = insertNewlineAndIndent(view)
  if (handled) lastEnterHandledAt = performance.now()
  return handled
}
