// In-place editable GFM table — a CM6 block widget rendering a real <table> whose
// each cell is its OWN nested CodeMirror EditorView (Approach B). Shared by the
// spike (#/dev/celledit) and the cm2 editor.
//
// Why a nested editor per cell: inline rendering (bold/links via livePreviewInline),
// multi-line content, and CJK IME all come from the same CM machinery the main
// editor uses — verified clean in the #/dev/nestedcell spike. CM's DOMObserver
// ignores widget-internal mutations and `ignoreEvent()=true` keeps the parent out
// of cell events, so each cell view owns its editing. We sync to the parent doc on
// cell blur by serializing every cell's nested doc into ONE transaction (native
// undo). In-cell line breaks (`\n`) round-trip to GFM `<br>`.

import { EditorState, Prec } from '@codemirror/state'
import { EditorView, WidgetType, keymap, drawSelection } from '@codemirror/view'
import { defaultKeymap, insertNewlineAndIndent, undo, redo } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'
import { GFM } from '@lezer/markdown'
import { livePreviewInline } from './livePreview'
import { addRow, addColumn, deleteRow, deleteColumn, applyContentColumns } from './tableEdit'
import { useEditorSelectionStore } from '@/state/editorSelectionStore'

const isDelim = (line: string): boolean => /^[\s|:-]+$/.test(line) && line.includes('-')
// Split a row into its source cells on UNESCAPED pipes only (a `\|` inside a cell is
// a literal pipe, not a boundary). Returns the still-escaped cell source.
const cellsOf = (line: string): string[] =>
  line
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim())

type WithView = HTMLElement & { _cellView?: EditorView }

// A cell's GFM SOURCE ↔ the nested editor's plain doc. Two cell-level escapes:
//  • line break — a real newline would end the table row, so it's stored as `<br>`.
//  • literal `|` — a bare pipe is a column boundary, so it's stored as `\|` (and a
//    literal `\` as `\\`). Without this, typing `|` in a cell splits it into columns.
const cellToDoc = (text: string): string =>
  text.replace(/<br\s*\/?>/gi, '\n').replace(/\\([\\|])/g, '$1')
const docToCell = (doc: string): string =>
  doc
    .replace(/([\\|])/g, '\\$1')
    .replace(/\n/g, '<br>')
    .trim()

// Self-contained theme for a tiny in-cell editor — does NOT reuse the prose page
// theme (whose 48px/120px page padding made cells huge). Just compact layout + the
// inline-mark styles the cell actually renders.
const cellTheme = EditorView.theme({
  '&': { fontSize: 'inherit', color: 'var(--foreground)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': {
    padding: '0.3em 0.55em',
    caretColor: 'transparent',
    fontFamily: 'var(--font-sans)',
  },
  '.cm-scroller': { lineHeight: '1.5', fontFamily: 'var(--font-sans)' },
  '.cm-cursor': { borderLeftColor: 'var(--foreground)' },
  '.cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in oklch, var(--info) 22%, transparent)',
  },
  '.cm-strong': { fontWeight: '700' },
  '.cm-em': { fontStyle: 'italic' },
  '.cm-strike': { textDecoration: 'line-through' },
  '.cm-inline-code': {
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: '0.9em',
    background: 'var(--muted)',
    padding: '0 0.3em',
    borderRadius: '0.25rem',
  },
  '.cm-link': { color: 'var(--info)', textDecoration: 'underline', textUnderlineOffset: '2px' },
  '.cm-wikilink': {
    color: 'var(--info)',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
    cursor: 'pointer',
  },
  '.cm-wikilink-broken': {
    color: 'var(--destructive, crimson)',
    textDecoration: 'underline dashed',
    textUnderlineOffset: '2px',
  },
  '.cm-wikilink-bracket': { color: 'var(--muted-foreground)' },
})

/** Re-serialize a rendered table to GFM source, reading each cell's NESTED editor
 * doc (not DOM text, which would be the rendered/marker-hidden version). */
export function serialize(root: HTMLElement, delim: string): string {
  const table = (root.querySelector('table') ?? root) as HTMLTableElement
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`
  const text = (c: HTMLTableCellElement) => {
    const v = (c as WithView)._cellView
    return docToCell(v ? v.state.doc.toString() : (c.textContent ?? ''))
  }
  const header = [...(table.tHead?.rows[0]?.cells ?? [])].map(text)
  const bodyRows = [...(table.tBodies[0]?.rows ?? [])].map((tr) => [...tr.cells].map(text))
  return [line(header), delim, ...bodyRows.map(line)].join('\n')
}

/** Canonical GFM for a table SOURCE string — the SAME normalization `serialize`
 * produces from the rendered DOM: each cell decoded then re-encoded (idempotent
 * escape round-trip + trim), single-spaced `| a | b |`, original delimiter kept.
 * Comparing canonical forms makes `eq`/`updateDOM` ignore incidental whitespace /
 * delimiter-format differences that don't change what renders — so an own-commit
 * (which re-normalizes the source) is recognized as unchanged and the cell views are
 * KEPT (caret/IME survive) instead of torn down and rebuilt. */
export function canonicalize(source: string, delim: string): string {
  const dataRows = source.split('\n').filter((l) => l.includes('|') && !isDelim(l))
  if (dataRows.length === 0) return source
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`
  const cells = (l: string) => cellsOf(l).map((c) => docToCell(cellToDoc(c)))
  const [header, ...body] = dataRows
  return [line(cells(header)), delim, ...body.map((r) => line(cells(r)))].join('\n')
}

export class EditableTableWidget extends WidgetType {
  readonly delim: string
  readonly canonical: string
  constructor(readonly source: string) {
    super()
    this.delim = source.split('\n').find(isDelim) ?? '| --- |'
    this.canonical = canonicalize(source, this.delim)
  }
  // Identity = the CANONICAL table, not the raw source: two sources that render the
  // same table (differing only in cell whitespace / delimiter formatting) are equal,
  // so CM keeps the DOM instead of churning.
  eq(o: EditableTableWidget) {
    return o.canonical === this.canonical
  }
  toDOM(view: EditorView) {
    const rows = this.source.split('\n').filter((l) => l.includes('|'))
    const table = document.createElement('table')
    table.className = 'cm-md-table cm-celledit'

    // The table's CURRENT document range, from the live syntax tree (NOT a captured
    // source length — see the in-place commit notes: updateDOM keeps stale closures).
    const rangeFromDoc = (): { from: number; to: number } => {
      const from = view.posAtDOM(table)
      let node = syntaxTree(view.state).resolveInner(from, 1)
      while (node && node.name !== 'Table') node = node.parent as typeof node
      const to = node
        ? view.state.doc.lineAt(Math.min(node.to, view.state.doc.length)).to
        : from + this.source.length
      return { from, to }
    }
    const commit = () => {
      const next = serialize(table, this.delim)
      const { from, to } = rangeFromDoc()
      if (view.state.doc.sliceString(from, to) === next) return
      // `userEvent: input` lets the parent history coalesce a run of cell keystrokes
      // into one undo step (CM groups same-userEvent changes within newGroupDelay).
      view.dispatch({ changes: { from, to, insert: next }, userEvent: 'input' })
    }
    const structOp = (fn: (src: string) => string) => (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const next = fn(serialize(table, this.delim))
      const { from, to } = rangeFromDoc()
      // An empty / data-less result means the op removed the last column (or row) —
      // the table can't exist, so delete its whole document range plus one bounding
      // newline (trailing if there is one, else leading) so no blank line is orphaned.
      if (!next.split('\n').some((l) => l.includes('|') && !isDelim(l))) {
        const delTo = to < view.state.doc.length ? to + 1 : to
        const delFrom = delTo > to ? from : Math.max(0, from - 1)
        view.dispatch({ changes: { from: delFrom, to: delTo }, userEvent: 'delete' })
        view.focus()
        return
      }
      if (view.state.doc.sliceString(from, to) !== next) {
        view.dispatch({ changes: { from, to, insert: next }, userEvent: 'input' })
      }
      view.focus() // so Cmd-Z reaches CM history (cells ignoreEvent the keypress)
    }

    // Cell views, row-major, for Tab/Shift-Tab nav and teardown.
    const grid: EditorView[][] = []
    const cellViews: EditorView[] = []
    // Collapse the currently-focused cell's selection to a caret before navigating
    // elsewhere. Each cell is its own EditorView that keeps rendering its selection
    // even when blurred, so Tab's select-all would otherwise leave a TRAIL of
    // highlighted cells behind the caret. Runs ONLY on programmatic nav (Tab/arrows) —
    // never on plain blur — so selecting a cell then clicking the chat keeps that
    // selection (and its context chip) alive.
    const collapseFocused = () => {
      for (const cv of cellViews) {
        if (cv.hasFocus && !cv.state.selection.main.empty) {
          cv.dispatch({ selection: { anchor: cv.state.selection.main.head } })
        }
      }
    }
    const focusCell = (v: EditorView) => {
      collapseFocused()
      v.focus()
      v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } }) // select-all
    }
    const nav = (v: EditorView, dir: 'next' | 'prev') => {
      const flat = grid.flat()
      const target = flat[flat.indexOf(v) + (dir === 'next' ? 1 : -1)]
      if (target) focusCell(target)
    }
    // ── Arrow navigation (cell ↔ cell, and out of the table at its edges) ────────
    const findPos = (v: EditorView): { r: number; c: number } | null => {
      for (let r = 0; r < grid.length; r++) {
        const c = grid[r].indexOf(v)
        if (c >= 0) return { r, c }
      }
      return null
    }
    const enterCell = (v: EditorView, atEnd: boolean) => {
      collapseFocused()
      v.focus()
      v.dispatch({ selection: { anchor: atEnd ? v.state.doc.length : 0 }, scrollIntoView: true })
    }
    // Escape the whole table to the parent line above (dir<0) / below (dir>0). The
    // `maybeEscape` half of the ProseMirror nested-editor pattern, via rangeFromDoc.
    const escapeTable = (dir: -1 | 1): boolean => {
      const { from, to } = rangeFromDoc()
      const no = dir < 0 ? view.state.doc.lineAt(from).number - 1 : view.state.doc.lineAt(to).number + 1
      if (no < 1 || no > view.state.doc.lines) return false // no line beyond the table that way
      collapseFocused() // clear the leaving cell's selection so no highlight lingers
      const tgt = view.state.doc.line(no)
      view.dispatch({ selection: { anchor: dir < 0 ? tgt.to : tgt.from }, scrollIntoView: true })
      view.focus()
      return true
    }
    // Returns true when the arrow CROSSES a boundary (handled here); false lets the
    // cell editor's own default motion run (char/line within the cell).
    const arrow = (v: EditorView, key: string): boolean => {
      const { main } = v.state.selection
      if (!main.empty) return false
      const len = v.state.doc.length
      const pos = findPos(v)
      if (!pos) return false
      if (key === 'ArrowUp') {
        if (v.state.doc.lineAt(main.head).from > 0) return false // not the cell's first line
        const above = grid[pos.r - 1]?.[pos.c]
        if (above) return (enterCell(above, true), true)
        return escapeTable(-1)
      }
      if (key === 'ArrowDown') {
        if (v.state.doc.lineAt(main.head).to < len) return false // not the cell's last line
        const below = grid[pos.r + 1]?.[pos.c]
        if (below) return (enterCell(below, false), true)
        return escapeTable(1)
      }
      const flat = grid.flat()
      const i = flat.indexOf(v)
      if (key === 'ArrowLeft') {
        if (main.head > 0) return false // not at the cell start
        const prev = flat[i - 1]
        if (prev) return (enterCell(prev, true), true)
        return escapeTable(-1)
      }
      // ArrowRight
      if (main.head < len) return false // not at the cell end
      const nextCell = flat[i + 1]
      if (nextCell) return (enterCell(nextCell, false), true)
      return escapeTable(1)
    }
    // Enter: move to the cell BELOW (same column). On the last row, append a row and
    // focus its same-column cell. The append rewrites the source → the widget
    // rebuilds (new cell views), so we re-find the new cell in a microtask (after the
    // update settles) by matching the table's stable start position.
    const enterDown = (v: EditorView): boolean => {
      const pos = findPos(v)
      if (!pos) return false
      const below = grid[pos.r + 1]?.[pos.c]
      if (below) return (enterCell(below, false), true)
      const col = pos.c
      const { from, to } = rangeFromDoc()
      const next = addRow(serialize(table, this.delim))
      if (view.state.doc.sliceString(from, to) === next) return true
      view.dispatch({ changes: { from, to, insert: next } })
      queueMicrotask(() => {
        for (const w of view.contentDOM.querySelectorAll<HTMLElement>('.cm-table-wrap')) {
          if (view.posAtDOM(w) !== from) continue
          const ww = w as TableWrap
          const cells = ww._cellViews
          const cols = ww._cols
          const target = cells && cols ? cells[cells.length - cols + col] : undefined
          if (target) enterCell(target, false)
          return
        }
      })
      return true
    }
    // Tab/Shift-Tab move between cells (select-all). Arrows move char/line within the
    // cell, then between cells, then out of the table. Enter → cell below / add row;
    // Shift-Enter → in-cell line break (serialized as <br>). Escape commits + leaves.
    const cellKeymap = Prec.highest(
      keymap.of([
        { key: 'Tab', run: (v) => (nav(v, 'next'), true) },
        { key: 'Shift-Tab', run: (v) => (nav(v, 'prev'), true) },
        { key: 'ArrowUp', run: (v) => arrow(v, 'ArrowUp') },
        { key: 'ArrowDown', run: (v) => arrow(v, 'ArrowDown') },
        { key: 'ArrowLeft', run: (v) => arrow(v, 'ArrowLeft') },
        { key: 'ArrowRight', run: (v) => arrow(v, 'ArrowRight') },
        { key: 'Enter', run: (v) => enterDown(v) },
        { key: 'Shift-Enter', run: insertNewlineAndIndent },
        { key: 'Escape', run: (v) => ((v.contentDOM as HTMLElement).blur(), true) },
        // Undo/redo belong to the PARENT (the single source of truth). With
        // commit-through, every cell edit already lives in the parent history, so we
        // forward Mod-z/Mod-Shift-z there instead of keeping a divergent per-cell
        // history (ProseMirror nested-editor pattern). commit() first flushes any
        // not-yet-committed cell state so the undo boundary is consistent.
        { key: 'Mod-z', run: () => (commit(), undo(view)) },
        { key: 'Mod-Shift-z', run: () => (commit(), redo(view)) },
        { key: 'Mod-y', run: () => (commit(), redo(view)) },
      ]),
    )

    const wireCell = (cell: HTMLTableCellElement, text: string): EditorView => {
      const cv = new EditorView({
        parent: cell,
        state: EditorState.create({
          doc: cellToDoc(text),
          extensions: [
            // NO per-cell history — undo is the parent's (see cellKeymap Mod-z).
            cellKeymap,
            keymap.of(defaultKeymap),
            drawSelection(),
            EditorView.lineWrapping,
            markdown({ extensions: [GFM], addKeymap: false }),
            livePreviewInline,
            cellTheme,
            // Bridge a cell's selection into the editor-agnostic store so the chat
            // panel's context chip picks it up — the main editor's updateListener
            // never sees it (the cell is a separate nested EditorView; the table is a
            // block widget the main selection can't enter). Text is the cell's own
            // (already-unescaped) doc; the line range is the WHOLE table's main-doc span
            // (rangeFromDoc) — the chip only needs a label, not char-exact main-doc
            // offsets, which the `<br>`/`\|` escaping would make unreliable. Empty
            // selection clears, matching the main editor. Scope: in-cell selection only.
            EditorView.updateListener.of((u) => {
              // Commit-through: mirror every cell edit into the parent doc the moment
              // it happens, so the parent (the source of truth) never lags the cell.
              // This closes the data-loss window where a rebuild between a cell edit
              // and blur re-rendered the table from the STALE parent source, resurrecting
              // deleted text. EXCEPT during IME composition — a mid-composition parent
              // rewrite churns the widget and corrupts the composition; the composition-
              // end handler below flushes it once the syllable is committed.
              if (u.docChanged && !u.view.composing) commit()
              if (!u.selectionSet && !u.docChanged) return
              const sel = u.state.selection.main
              const store = useEditorSelectionStore.getState()
              if (sel.empty) {
                store.setSelection(null)
                return
              }
              const { from, to } = rangeFromDoc()
              store.setSelection({
                text: u.state.sliceDoc(sel.from, sel.to),
                fromLine: view.state.doc.lineAt(from).number,
                toLine: view.state.doc.lineAt(to).number,
              })
            }),
            EditorView.domEventHandlers({
              blur: () => commit(), // backstop: nav/click-away still commits
              // Flush the composition once it ends (updateListener skipped it while
              // composing). Microtask so the cell doc has the final composed text.
              compositionend: () => void queueMicrotask(commit),
            }),
          ],
        }),
      })
      ;(cell as WithView)._cellView = cv
      cellViews.push(cv)
      return cv
    }
    const delHandle = (cls: string, label: string, fn: (src: string) => string): HTMLButtonElement => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = cls
      b.textContent = '×'
      b.setAttribute('aria-label', label)
      b.addEventListener('mousedown', structOp(fn))
      return b
    }

    // Per-column alignment from the delimiter.
    const aligns = cellsOf(this.delim).map((c) => {
      const l = c.startsWith(':')
      const r = c.endsWith(':')
      return l && r ? 'center' : r ? 'right' : l ? 'left' : ''
    })

    let headerDone = false
    let body: HTMLTableSectionElement | null = null
    let dataIndex = -1
    for (const line of rows) {
      if (isDelim(line)) continue
      const rowCells: EditorView[] = []
      if (!headerDone) {
        const tr = table.createTHead().insertRow()
        cellsOf(line).forEach((c, i) => {
          const th = document.createElement('th')
          if (aligns[i]) th.style.textAlign = aligns[i]
          rowCells.push(wireCell(th, c))
          th.appendChild(delHandle('cm-table-delcol', 'Delete column', (s) => deleteColumn(s, i)))
          tr.appendChild(th)
        })
        headerDone = true
      } else {
        if (!body) body = table.createTBody()
        const tr = body.insertRow()
        const di = ++dataIndex
        cellsOf(line).forEach((c, i) => {
          const td = tr.insertCell()
          if (aligns[i]) td.style.textAlign = aligns[i]
          rowCells.push(wireCell(td, c))
          if (i === 0) td.appendChild(delHandle('cm-table-delrow', 'Delete row', (s) => deleteRow(s, di)))
        })
      }
      grid.push(rowCells)
    }

    // Full-width table with content-proportional columns — shared with the
    // read-only renderer, avoids WebKit's surplus-width guesswork. See tableEdit.ts.
    applyContentColumns(table, this.source)

    // `wrap` owns the vertical SPACING as PADDING (not margin) so CM6's heightmap —
    // which measures a block widget by its bounding box, excluding margins — sees
    // the full height; with margin the map was ~28px short per table and clicks /
    // vertical arrows below the table mapped to the wrong line. `frame` (no padding,
    // position:relative) hugs the table so the hover rails anchor to the table edge,
    // not to the padded wrap.
    const wrap = document.createElement('div') as HTMLElement & {
      _cellViews?: EditorView[]
      _cols?: number
    }
    wrap.className = 'cm-table-wrap'
    const frame = document.createElement('div')
    frame.className = 'cm-table-frame'
    frame.appendChild(table)
    const rail = (cls: string, label: string, fn: (src: string) => string) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = cls
      b.textContent = '+'
      b.setAttribute('aria-label', label)
      b.addEventListener('mousedown', structOp(fn))
      frame.appendChild(b)
    }
    rail('cm-table-addcol', 'Add column', addColumn)
    rail('cm-table-addrow', 'Add row', addRow)
    wrap.appendChild(frame)
    wrap._cellViews = cellViews
    wrap._cols = grid[0]?.length ?? 1
    return wrap
  }
  // Own-commit re-render → keep DOM (focus/IME of nested cell views survive);
  // otherwise (undo / external edit that changes cell CONTENT) let CM rebuild.
  // Compare the DOM's serialization to the CANONICAL new source (not the raw source):
  // `serialize(dom)` is already normalized, so an own-commit — even when the committed
  // text re-normalized whitespace/escaping — matches and the cell views are kept.
  updateDOM(dom: HTMLElement) {
    return serialize(dom, this.delim) === this.canonical
  }
  // CM does NOT auto-destroy nested views — release every cell view on teardown.
  destroy(dom: HTMLElement) {
    ;(dom as HTMLElement & { _cellViews?: EditorView[] })._cellViews?.forEach((v) => v.destroy())
  }
  ignoreEvent() {
    return true
  }
  get estimatedHeight() {
    return 120
  }
}

// ── OUTER → INNER: enter the table with arrow keys ──────────────────────────────
// A PARENT-editor keymap: when the caret is on the line just above/below a table,
// ArrowDown/ArrowUp focuses a cell of the first/last row instead of skipping the
// block. Add `tableArrowEntry` to the PARENT editor's extensions. (The INNER→OUTER
// escape lives on each cell's keymap.) Finds the rendered table via the stored
// `_cellViews` on its `.cm-table-wrap` DOM.
type TableWrap = HTMLElement & { _cellViews?: EditorView[]; _cols?: number }

function tableWrapAdjacent(view: EditorView, dir: -1 | 1): TableWrap | null {
  const { main } = view.state.selection
  if (!main.empty) return null
  const curLine = view.state.doc.lineAt(main.head)
  const probe = dir < 0 ? curLine.from - 1 : curLine.to + 1
  if (probe < 0 || probe > view.state.doc.length) return null
  // Is the adjacent line a table? Resolve with side = dir: going UP, `probe` sits at
  // the table's END boundary, so side +1 would pick the FOLLOWING block — we must
  // look backward (-1) into the table that ends there. Going down it's the reverse.
  let node = syntaxTree(view.state).resolveInner(probe, dir)
  while (node && node.name !== 'Table') node = node.parent as typeof node
  if (!node) return null
  const from = view.state.doc.lineAt(node.from).from
  const to = view.state.doc.lineAt(Math.min(node.to, view.state.doc.length)).to
  // Find the RENDERED wrap for this table by matching its document position. NOT via
  // `domAtPos(insideTable)` + `closest`: for a block widget, domAtPos points at the
  // widget from its PARENT (parent node + sibling offset), so `closest` (ancestor
  // search) can never reach `.cm-table-wrap`, which is a CHILD. `posAtDOM` on the
  // wrap returns the block's start, which lands in [from, to].
  for (const w of view.contentDOM.querySelectorAll<HTMLElement>('.cm-table-wrap')) {
    const p = view.posAtDOM(w)
    if (p >= from && p <= to) return w as TableWrap
  }
  return null
}

const enterTable = (dir: -1 | 1) => (view: EditorView): boolean => {
  const wrap = tableWrapAdjacent(view, dir)
  const cells = wrap?._cellViews
  if (!wrap || !cells || cells.length === 0) return false
  const cols = wrap._cols ?? 1
  // From above (ArrowDown, dir>0) → first cell, caret start. From below (ArrowUp,
  // dir<0) → first cell of the LAST row, caret end. (Same-column entry is a later,
  // x-coordinate-based refinement.)
  const target = dir > 0 ? cells[0] : cells[Math.max(0, cells.length - cols)]
  target.focus()
  target.dispatch({ selection: { anchor: dir > 0 ? 0 : target.state.doc.length }, scrollIntoView: true })
  return true
}

export const tableArrowEntry = Prec.highest(
  keymap.of([
    { key: 'ArrowDown', run: enterTable(1) },
    { key: 'ArrowUp', run: enterTable(-1) },
  ]),
)
