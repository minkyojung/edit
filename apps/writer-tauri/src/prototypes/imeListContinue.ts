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
// Guard against double newlines: a NORMAL (non-composition) Enter is already
// handled by the keymap AND also emits this beforeinput. So we only take over
// inside the post-compositionend window where CM drops the key; otherwise we
// stand back and let the keymap do its job.

import { EditorView } from '@codemirror/view'
import { Prec, type Extension } from '@codemirror/state'
import { smartEnter } from './listEnter'

const NEWLINE_INTENT = new Set(['insertParagraph', 'insertLineBreak'])

// Window (ms) after compositionend during which CM drops the Enter. Mirrors
// CM's own 100ms Safari guard.
const COMPOSE_WINDOW_MS = 100

export function imeListContinue(): Extension {
  let lastCompositionEnd = 0
  return Prec.highest(
    EditorView.domEventHandlers({
      compositionend() {
        lastCompositionEnd = performance.now()
        return false
      },
      beforeinput(event, view) {
        if (!NEWLINE_INTENT.has(event.inputType)) return false
        // Only when this newline is the composition-confirming Enter that CM
        // just dropped — otherwise the keymap already handled it.
        const nearComposition =
          view.composing || performance.now() - lastCompositionEnd < COMPOSE_WINDOW_MS
        if (!nearComposition) return false
        // Stop the browser's bare line break and run the SAME chain the Enter
        // keymap would (CodeMirrorPreview.tsx): continue the list/quote if
        // applicable, else fall back to the normal newline. Running only the
        // first command and prevent-defaulting swallowed Enter in plain text /
        // empty-item-exit cases (the "have to press Enter twice" regression).
        event.preventDefault()
        return smartEnter(view)
      },
    }),
  )
}
