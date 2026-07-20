// Fix for "type Korean in a list, press Enter → no new bullet" on Safari/WKWebView.
//
// Mechanism (confirmed by imeProbe in the real Tauri window):
//   compositionend → keydown(Enter, isComposing=false, ~4ms later) → beforeinput
//   inputType=insertLineBreak.
// CodeMirror's DOMObserver deliberately DROPS that Enter keydown (ignoreDuring
// composition: on Safari it ignores a key within 100ms of compositionend, since
// Safari emits compositionend/keydown out of order). So the keymap's
// `insertNewlineContinueMarkup` never runs and the list/quote isn't continued —
// you get a bare newline (or nothing).
//
// We recover it from the ONE language-agnostic signal: the browser's own
// `beforeinput` with inputType insertParagraph / insertLineBreak, which fires
// ONLY when the user genuinely means a newline. A Japanese/Chinese Enter that
// merely confirms a conversion candidate does NOT emit it (it stays in
// composition events), so this never mis-fires for CJK — every language behaves
// correctly without per-language branching.
//
// Guard against double / dropped newlines: a NORMAL (non-composition) Enter is
// handled by the keymap (keydown). We must NOT also run here. Earlier this used a
// separate 100ms "near compositionend" timer that had to MATCH CM's own internal
// drop window — two independent clocks that disagreed at the boundary, so an Enter
// could fire twice or zero times. Instead we dedupe on the SINGLE source of truth:
// `enterHandledRecently()` — did smartEnter actually run just now (via the keymap)?
// If yes, the keymap already took this Enter → stand down. If no (CM dropped the
// composition-confirming keydown), this beforeinput is the only path → run it.

import { EditorView } from '@codemirror/view'
import { Prec, type Extension } from '@codemirror/state'
import { smartEnter, shiftEnter, enterHandledRecently } from './listEnter'

export function imeListContinue(): Extension {
  return Prec.highest(
    EditorView.domEventHandlers({
      beforeinput(event, view) {
        // insertParagraph = Enter (new item / exit), insertLineBreak = Shift+Enter
        // (indented continuation). Route each to the SAME handler the keymap uses, so
        // a composition-confirming key CM dropped still does the right thing.
        const isParagraph = event.inputType === 'insertParagraph'
        const isLineBreak = event.inputType === 'insertLineBreak'
        if (!isParagraph && !isLineBreak) return false
        if (enterHandledRecently()) return false // the keymap already took this key
        event.preventDefault()
        return isLineBreak ? shiftEnter(view) : smartEnter(view)
      },
    }),
  )
}
