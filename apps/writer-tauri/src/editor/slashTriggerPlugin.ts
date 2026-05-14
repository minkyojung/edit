// Detect the slash-menu trigger condition (`/` at the start of an
// empty-selection textblock, optionally followed by a query) and push
// the result to slashStore. UI-free on its own — verify via:
//   window.slashStore.subscribe((s) => console.log(s.active))
//
// IME-aware: skips evaluation while `view.composing` is true so a
// half-formed Korean/Japanese composition that happens to contain a
// `/` doesn't fire spurious triggers. Re-evaluates on compositionend
// once PM has flushed the composed text into the document.
//
// We deliberately scope the trigger to *the start of a textblock*
// (not "after any whitespace"). Mid-paragraph slashes are noisy in a
// writing-first editor, and the inputrules already cover inline
// patterns like `**x**`.

import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

import { useSlashStore } from '@/state/slashStore'

const TRIGGER_RE = /^\/([\p{L}\p{N}_]*)$/u

function evaluate(view: EditorView): void {
  const set = useSlashStore.getState().setActive

  if (view.composing) return // wait for compositionend to re-evaluate

  const { state } = view
  const sel = state.selection
  if (!sel.empty) {
    set(null)
    return
  }

  const $head = sel.$head
  const parent = $head.parent
  if (!parent.isTextblock) {
    set(null)
    return
  }
  // Code blocks own their `/` (it's source text, not editor input).
  if (parent.type.name === 'code_block') {
    set(null)
    return
  }

  const text = parent.textContent
  const offset = $head.parentOffset
  const before = text.slice(0, offset)
  const m = TRIGGER_RE.exec(before)
  if (!m) {
    set(null)
    return
  }

  const blockStart = $head.start()
  const from = blockStart // `/` is the first char of the textblock
  const to = blockStart + offset
  const coords = view.coordsAtPos(from)
  set({
    from,
    to,
    query: m[1],
    coords: { left: coords.left, top: coords.top, bottom: coords.bottom },
  })
}

export function createSlashTriggerPlugin() {
  return $prose(() => {
    return new Plugin({
      view() {
        return {
          update(view, prevState) {
            // Skip when nothing relevant changed — keeps this off the
            // hot path of cosmetic decoration updates.
            if (
              view.state.doc === prevState.doc &&
              view.state.selection.eq(prevState.selection)
            ) {
              return
            }
            evaluate(view)
          },
          destroy() {
            useSlashStore.getState().setActive(null)
          },
        }
      },
      props: {
        handleDOMEvents: {
          compositionend(view) {
            // PM applies composed text on compositionend; defer one
            // tick so our re-evaluation sees the resulting state.
            window.setTimeout(() => evaluate(view), 0)
            return false
          },
        },
      },
    })
  })
}
