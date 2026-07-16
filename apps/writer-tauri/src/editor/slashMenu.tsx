// Editor slash menu — OWNED rendering (not @codemirror/autocomplete).
//
// Structure (see the three CM primitives):
//   • StateField<SlashState>  — open/close, query range, filtered items, index.
//   • showTooltip (via provide) — CM anchors + repositions the popup at the `/`.
//   • Prec.highest keymap      — ↑/↓/Enter/Tab/Esc, only while the menu is open.
// The DOM inside the tooltip is our React <EditorSlashMenu>, so it shares the
// chat SlashPalette's look with zero CSS-override war against CM's baseTheme.

import {
  Prec,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from '@codemirror/state'
import {
  EditorView,
  keymap,
  showTooltip,
  type Tooltip,
  type TooltipView,
} from '@codemirror/view'
import { createRoot, type Root } from 'react-dom/client'
import { filterSlashItems, inCodeBlock, type SlashItem } from '@/editor/engine/slashCommands'
import { EditorSlashMenu } from './EditorSlashMenu'

export interface SlashState {
  from: number // position of the `/` (tooltip anchor)
  to: number // caret (end of `/query`)
  items: SlashItem[]
  selectedIndex: number
}

const setIndex = StateEffect.define<number>()
const closeSlash = StateEffect.define<void>()

/** Trigger: `/query` occupying the whole line up to the caret (⇒ line-start
 * only), single empty cursor, not inside a code block, at least one match.
 * `prev` carries the selected index so it survives query edits. Exported for
 * headless tests. */
export function readSlash(state: EditorState, prev: SlashState | null): SlashState | null {
  const sel = state.selection.main
  if (!sel.empty) return null
  const line = state.doc.lineAt(sel.head)
  const before = state.sliceDoc(line.from, sel.head)
  if (!/^\/[\p{L}\p{N}_]*$/u.test(before)) return null
  if (inCodeBlock(state, sel.head)) return null
  const items = filterSlashItems(before.slice(1))
  if (!items.length) return null
  const selectedIndex = prev ? Math.min(prev.selectedIndex, items.length - 1) : 0
  return { from: line.from, to: sel.head, items, selectedIndex }
}

const slashField = StateField.define<SlashState | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(closeSlash)) return null
      if (e.is(setIndex) && value) value = { ...value, selectedIndex: e.value }
    }
    // Re-derive on any doc/selection change; keyboard-only ticks (setIndex) keep
    // the value computed above.
    if (tr.docChanged || tr.selection) return readSlash(tr.state, value)
    return value
  },
  provide: (f) =>
    showTooltip.from(
      f,
      (s): Tooltip | null => (s ? { pos: s.from, above: false, create: slashTooltip } : null),
    ),
})

// STABLE module-level reference — CM's TooltipViewManager reuses a TooltipView
// while `create` identity is unchanged, so the React root is NOT remounted on
// every keystroke (only .update() fires).
function slashTooltip(view: EditorView): TooltipView {
  const dom = document.createElement('div')
  // CM tags this element `.cm-tooltip` and its baseTheme paints a light/dark
  // border+background on it. Our React panel owns all visuals, so neutralize
  // that frame (inline beats the class); leave z-index/box-sizing to CM.
  dom.style.border = 'none'
  dom.style.background = 'transparent'
  let root: Root | null = createRoot(dom)
  const render = () => {
    const s = view.state.field(slashField, false)
    if (!s || !root) return
    root.render(
      <EditorSlashMenu
        items={s.items}
        selectedIndex={s.selectedIndex}
        onSelect={(i) => applyItem(view, i)}
        onHover={(i) => view.dispatch({ effects: setIndex.of(i) })}
      />,
    )
  }
  return {
    dom,
    mount: () => render(),
    update: (u) => {
      if (u.state.field(slashField, false) !== u.startState.field(slashField, false)) render()
    },
    destroy: () => {
      root?.unmount()
      root = null
    },
  }
}

function applyItem(view: EditorView, index: number): void {
  const s = view.state.field(slashField, false)
  const item = s?.items[index]
  if (!s || !item) return
  item.apply(view, s.from, s.to) // dispatches the doc change itself
  view.dispatch({ effects: closeSlash.of() })
  view.focus()
}

function move(view: EditorView, delta: number): boolean {
  const s = view.state.field(slashField, false)
  if (!s) return false // menu closed → let the key through (cursor move, etc.)
  const n = s.items.length
  view.dispatch({ effects: setIndex.of((s.selectedIndex + delta + n) % n) })
  return true
}

function confirm(view: EditorView): boolean {
  const s = view.state.field(slashField, false)
  if (!s) return false
  if (view.composing) return false // mid-IME composition → don't steal Enter
  applyItem(view, s.selectedIndex)
  return true
}

function close(view: EditorView): boolean {
  if (!view.state.field(slashField, false)) return false
  view.dispatch({ effects: closeSlash.of() })
  return true
}

/** The slash keymap. Kept separate + at Prec.highest so it can be placed BEFORE
 * the editor's `smartEnter` handler (which otherwise swallows every Enter). */
export const slashKeymap: Extension = Prec.highest(
  keymap.of([
    { key: 'ArrowDown', run: (v) => move(v, 1) },
    { key: 'ArrowUp', run: (v) => move(v, -1) },
    { key: 'Enter', run: confirm },
    { key: 'Tab', run: confirm },
    { key: 'Escape', run: close },
  ]),
)

/** State + tooltip half of the slash menu. Pair with `slashKeymap`, placed
 * before `smartEnter` in the extension list. */
export const slashMenu: Extension = [slashField]
