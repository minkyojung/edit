// Fix for "type Korean in a list, press Enter → no new bullet" on Safari/WKWebView.
//
// Mechanism (confirmed live in the bundled debug app, 2026-07-21):
//   compositionend → keydown(Enter, isComposing=false, ~4ms later) → beforeinput
//   inputType=insertLineBreak   ← NOTE: insertLineBreak, NOT insertParagraph,
//   even for a PLAIN Enter — WebKit reports a composition-confirming plain Enter
//   with the same inputType as a genuine Shift+Enter.
// CodeMirror deliberately DROPS that Enter keydown: `ignoreDuringComposition`
// (@codemirror/view, Safari-only branch) ignores any key event within 100ms of
// compositionend, because Safari emits compositionend/keydown out of order. So
// the Enter keymap never runs and the list isn't continued. (Chromium has no such
// branch — which is why Electron apps like Obsidian never hit this.)
//
// We recover it from the ONE language-agnostic signal: the browser's own
// `beforeinput` with inputType insertParagraph / insertLineBreak, which fires
// ONLY when the user genuinely means a newline. A Japanese/Chinese Enter that
// merely confirms a conversion candidate does NOT emit it (it stays in
// composition events), so this never mis-fires for CJK.
//
// Routing plain Enter vs Shift+Enter: inputType CANNOT distinguish them here (see
// above), so we read the real `shiftKey` off the Enter keydown itself. That
// listener must be a RAW addEventListener on contentDOM — it can NOT go through
// EditorView.domEventHandlers, because CM's handleEvent() gates ALL registered
// key handlers behind the same `ignoreDuringComposition` check that drops the
// key in the first place (a gated keydown never reaches extension handlers).
//
// Dedupe guard against double / dropped newlines: a NORMAL Enter is handled by
// the keymap (keydown). We dedupe on the SINGLE source of truth
// `enterHandledRecently()` — did smartEnter/shiftEnter actually run just now via
// the keymap? If yes, stand down. If no (CM dropped the composition-confirming
// keydown), this beforeinput is the only path → run it.

import { EditorView, ViewPlugin } from '@codemirror/view'
import { Prec, type Extension } from '@codemirror/state'
import { smartEnter, shiftEnter, enterHandledRecently } from './listEnter'

// Shift state of the most recent Enter keydown, recorded by a raw DOM listener
// (module-level: one keyboard, however many editors).
let lastEnterShift = false
let lastEnterAt = -1

const enterShiftRecorder = ViewPlugin.define((view) => {
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      lastEnterShift = event.shiftKey
      lastEnterAt = performance.now()
    }
  }
  // Capture phase, observe-only. Raw listener so CM's ignoreDuringComposition
  // gate (which swallows this exact keydown from extension handlers) can't hide
  // it from us.
  view.contentDOM.addEventListener('keydown', onKeydown, true)
  return {
    destroy() {
      view.contentDOM.removeEventListener('keydown', onKeydown, true)
    },
  }
})

export function imeListContinue(): Extension {
  return [
    enterShiftRecorder,
    Prec.highest(
      EditorView.domEventHandlers({
        beforeinput(event, view) {
          // insertParagraph / insertLineBreak are the only inputTypes that mean a
          // newline. Route to the SAME handlers the keymap uses, so a composition-
          // confirming Enter that CM dropped still does the right thing.
          const isParagraph = event.inputType === 'insertParagraph'
          const isLineBreak = event.inputType === 'insertLineBreak'
          if (!isParagraph && !isLineBreak) return false
          if (enterHandledRecently()) return false // the keymap already took this key
          event.preventDefault()
          // Shift+Enter → soft continuation; plain Enter → new item / exit. The
          // real shiftKey comes from the raw keydown recorder; fall back to the
          // inputType heuristic only if no Enter keydown was seen at all.
          const shift = performance.now() - lastEnterAt < 100 ? lastEnterShift : isLineBreak
          return shift ? shiftEnter(view) : smartEnter(view)
        },
      }),
    ),
  ]
}
