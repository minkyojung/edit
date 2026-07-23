// Editor `[[` wikilink menu — OWNED rendering, twin of `slashMenu.tsx`.
//
// The `[[ note ]]` picker used to be @codemirror/autocomplete; this replaces it
// with the exact same primitives the `/` block menu uses so both read as one
// product:
//   • StateField<WikilinkState>  — open/close, `[[query` range, matches, index.
//   • showTooltip (via provide)  — CM anchors + repositions the popup at `[[`.
//   • Prec.highest keymap        — ↑/↓/Enter/Tab/Esc, only while the menu is open.
// The DOM inside the tooltip is our React <EditorWikilinkMenu> (same panel/row
// vocabulary as <EditorSlashMenu>).

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
import { inCodeBlock } from '@/editor/extensions/slashCommands'
import { useDocsStore } from '@/state/docsStore'
import { getActiveSlugFromHash } from '@/lib/viewUrl'
import { EditorWikilinkMenu } from './EditorWikilinkMenu'

export interface WikilinkItem {
  /** Row label — a note title, or the query for the "Create" row. */
  title: string
  /** True → the "Create <title>" row (inserts the link AND creates the note). */
  create?: boolean
  /** Insert into the doc, replacing the `[[query` range. */
  apply: (view: EditorView, from: number, to: number) => void
}

export interface WikilinkState {
  from: number // position of the leading `[[` (tooltip anchor + replace start)
  to: number // caret (end of `[[query`)
  items: WikilinkItem[]
  selectedIndex: number
}

const setIndex = StateEffect.define<number>()
const closeWikilink = StateEffect.define<void>()

/** Live, user-facing note titles (archived + system excluded), de-duped
 * case-insensitively (first wins) — same filter as resolution / broken styling. */
function liveTitles(): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const d of useDocsStore.getState().knownDocs) {
    if (d.type.startsWith('system:')) continue
    const title = (d.title ?? '').trim()
    if (!title) continue
    const key = title.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(title)
  }
  return out
}

function insertWikilink(view: EditorView, title: string, from: number, to: number): void {
  const insert = `[[${title}]]`
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } })
}

// Create-on-pick: insert the link now, then create the note (fire-and-forget) so
// it resolves to a real doc — the next decoration rebuild styles it live. Mirrors
// WikilinkPalette: a writing nests one-deep under its daily ancestor.
function insertAndCreate(view: EditorView, title: string, from: number, to: number): void {
  insertWikilink(view, title, from, to)
  const store = useDocsStore.getState()
  const active = getActiveSlugFromHash()
  const dailyParent = active ? store.findDailyAncestorSlug(active) : null
  if (dailyParent) void store.createWritingChild(dailyParent, title)
}

/** Trigger: `[[query` (query has no `]`, `[`, or newline) ending at the caret,
 * single empty cursor, not inside code, at least one match. `prev` carries the
 * selected index so it survives query edits. Exported for headless tests. */
export function readWikilink(state: EditorState, prev: WikilinkState | null): WikilinkState | null {
  const sel = state.selection.main
  if (!sel.empty) return null
  const line = state.doc.lineAt(sel.head)
  const before = state.sliceDoc(line.from, sel.head)
  const m = /\[\[[^\]\n[]*$/.exec(before)
  if (!m) return null
  if (inCodeBlock(state, sel.head)) return null

  const from = sel.head - m[0].length
  const query = m[0].slice(2) // drop the leading `[[`
  const q = query.trim().toLowerCase()
  const titles = liveTitles()
  const matches = titles.filter((t) => !q || t.toLowerCase().includes(q))

  const items: WikilinkItem[] = matches.map((t) => ({
    title: t,
    apply: (v, f, to) => insertWikilink(v, t, f, to),
  }))
  if (q && !titles.some((t) => t.toLowerCase() === q)) {
    const name = query.trim()
    items.push({ title: name, create: true, apply: (v, f, to) => insertAndCreate(v, name, f, to) })
  }
  if (!items.length) return null

  const selectedIndex = prev ? Math.min(prev.selectedIndex, items.length - 1) : 0
  return { from, to: sel.head, items, selectedIndex }
}

const wikilinkField = StateField.define<WikilinkState | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(closeWikilink)) return null
      if (e.is(setIndex) && value) value = { ...value, selectedIndex: e.value }
    }
    // Re-derive on any doc/selection change; keyboard-only ticks (setIndex) keep
    // the value computed above.
    if (tr.docChanged || tr.selection) return readWikilink(tr.state, value)
    return value
  },
  provide: (f) =>
    showTooltip.from(
      f,
      (s): Tooltip | null => (s ? { pos: s.from, above: false, create: wikilinkTooltip } : null),
    ),
})

// STABLE module-level reference — CM's TooltipViewManager reuses a TooltipView
// while `create` identity is unchanged, so the React root is NOT remounted on
// every keystroke (only .update() fires).
function wikilinkTooltip(view: EditorView): TooltipView {
  const dom = document.createElement('div')
  // Neutralize CM's baseTheme `.cm-tooltip` frame; our React panel owns visuals.
  dom.style.border = 'none'
  dom.style.background = 'transparent'
  let root: Root | null = createRoot(dom)
  const render = () => {
    const s = view.state.field(wikilinkField, false)
    if (!s || !root) return
    root.render(
      <EditorWikilinkMenu
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
      if (u.state.field(wikilinkField, false) !== u.startState.field(wikilinkField, false)) render()
    },
    destroy: () => {
      root?.unmount()
      root = null
    },
  }
}

function applyItem(view: EditorView, index: number): void {
  const s = view.state.field(wikilinkField, false)
  const item = s?.items[index]
  if (!s || !item) return
  item.apply(view, s.from, s.to) // dispatches the doc change itself
  view.dispatch({ effects: closeWikilink.of() })
  view.focus()
}

function move(view: EditorView, delta: number): boolean {
  const s = view.state.field(wikilinkField, false)
  if (!s) return false // menu closed → let the key through (cursor move, etc.)
  const n = s.items.length
  view.dispatch({ effects: setIndex.of((s.selectedIndex + delta + n) % n) })
  return true
}

function confirm(view: EditorView): boolean {
  const s = view.state.field(wikilinkField, false)
  if (!s) return false
  if (view.composing) return false // mid-IME composition → don't steal Enter
  applyItem(view, s.selectedIndex)
  return true
}

function close(view: EditorView): boolean {
  if (!view.state.field(wikilinkField, false)) return false
  view.dispatch({ effects: closeWikilink.of() })
  return true
}

/** The `[[` keymap. Kept separate + at Prec.highest so it can be placed BEFORE
 * the editor's `smartEnter` handler (which otherwise swallows every Enter). */
export const wikilinkKeymap: Extension = Prec.highest(
  keymap.of([
    { key: 'ArrowDown', run: (v) => move(v, 1) },
    { key: 'ArrowUp', run: (v) => move(v, -1) },
    { key: 'Enter', run: confirm },
    { key: 'Tab', run: confirm },
    { key: 'Escape', run: close },
  ]),
)

/** State + tooltip half of the `[[` menu. Pair with `wikilinkKeymap`, placed
 * before `smartEnter` in the extension list. */
export const wikilinkMenu: Extension = [wikilinkField]
