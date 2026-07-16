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
 * The full Enter behaviour for the editor (and the IME-recovery path). Order:
 *  1. listEnter — deterministic tight list continuation / clean exit.
 *  2. blockquote (`>`) ONLY → CM's markup-continue (it handles quote continuation
 *     fine). We gate it to quote lines because `insertNewlineContinueMarkup`
 *     MIS-handles a paragraph that lezer treats as a list item's lazy continuation
 *     (a non-marker line directly under a task) — it deletes the text. So for any
 *     non-list, non-quote line we use a plain newline instead.
 *  3. plain newline.
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
  let handled = listEnter(view)
  if (!handled) {
    const line = view.state.doc.lineAt(view.state.selection.main.head)
    handled = /^\s*>/.test(line.text) ? insertNewlineContinueMarkup(view) : insertNewlineAndIndent(view)
  }
  if (handled) lastEnterHandledAt = performance.now()
  return handled
}
