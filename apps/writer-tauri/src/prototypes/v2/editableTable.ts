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
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'
import { GFM } from '@lezer/markdown'
import { livePreviewInline } from './livePreview'
import { addRow, addColumn, deleteRow, deleteColumn } from '../tableEdit'

const isDelim = (line: string): boolean => /^[\s|:-]+$/.test(line) && line.includes('-')
const cellsOf = (line: string): string[] =>
  line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())

type WithView = HTMLElement & { _cellView?: EditorView }

// A cell's GFM source ↔ the nested editor's plain doc. `<br>` is how a table cell
// stores a line break (a real newline would end the row), so map both ways.
const cellToDoc = (text: string): string => text.replace(/<br\s*\/?>/gi, '\n')
const docToCell = (doc: string): string => doc.replace(/\n/g, '<br>').trim()

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

export class EditableTableWidget extends WidgetType {
  readonly delim: string
  constructor(readonly source: string) {
    super()
    this.delim = source.split('\n').find(isDelim) ?? '| --- |'
  }
  eq(o: EditableTableWidget) {
    return o.source === this.source
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
      view.dispatch({ changes: { from, to, insert: next } })
    }
    const structOp = (fn: (src: string) => string) => (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const next = fn(serialize(table, this.delim))
      const { from, to } = rangeFromDoc()
      if (view.state.doc.sliceString(from, to) !== next) {
        view.dispatch({ changes: { from, to, insert: next } })
      }
      view.focus() // so Cmd-Z reaches CM history (cells ignoreEvent the keypress)
    }

    // Cell views, row-major, for Tab/Shift-Tab nav and teardown.
    const grid: EditorView[][] = []
    const cellViews: EditorView[] = []
    const focusCell = (v: EditorView) => {
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
      v.focus()
      v.dispatch({ selection: { anchor: atEnd ? v.state.doc.length : 0 }, scrollIntoView: true })
    }
    // Escape the whole table to the parent line above (dir<0) / below (dir>0). The
    // `maybeEscape` half of the ProseMirror nested-editor pattern, via rangeFromDoc.
    const escapeTable = (dir: -1 | 1): boolean => {
      const { from, to } = rangeFromDoc()
      const no = dir < 0 ? view.state.doc.lineAt(from).number - 1 : view.state.doc.lineAt(to).number + 1
      if (no < 1 || no > view.state.doc.lines) return false // no line beyond the table that way
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
    // Tab/Shift-Tab move between cells (select-all, spreadsheet-style). Arrows move
    // char/line within the cell, then between cells, then out of the table. Escape
    // commits + leaves. (Enter = newline default for now → Enter-adds-row is later.)
    const cellKeymap = Prec.highest(
      keymap.of([
        { key: 'Tab', run: (v) => (nav(v, 'next'), true) },
        { key: 'Shift-Tab', run: (v) => (nav(v, 'prev'), true) },
        { key: 'ArrowUp', run: (v) => arrow(v, 'ArrowUp') },
        { key: 'ArrowDown', run: (v) => arrow(v, 'ArrowDown') },
        { key: 'ArrowLeft', run: (v) => arrow(v, 'ArrowLeft') },
        { key: 'ArrowRight', run: (v) => arrow(v, 'ArrowRight') },
        { key: 'Escape', run: (v) => ((v.contentDOM as HTMLElement).blur(), true) },
      ]),
    )

    const wireCell = (cell: HTMLTableCellElement, text: string): EditorView => {
      const cv = new EditorView({
        parent: cell,
        state: EditorState.create({
          doc: cellToDoc(text),
          extensions: [
            history(),
            cellKeymap,
            keymap.of([...defaultKeymap, ...historyKeymap]),
            drawSelection(),
            EditorView.lineWrapping,
            markdown({ extensions: [GFM], addKeymap: false }),
            livePreviewInline,
            cellTheme,
            EditorView.domEventHandlers({ blur: () => commit() }),
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

    // `wrap` owns the vertical SPACING as PADDING (not margin) so CM6's heightmap —
    // which measures a block widget by its bounding box, excluding margins — sees
    // the full height; with margin the map was ~28px short per table and clicks /
    // vertical arrows below the table mapped to the wrong line. `frame` (no padding,
    // position:relative) hugs the table so the hover rails anchor to the table edge,
    // not to the padded wrap.
    const wrap = document.createElement('div') as HTMLElement & { _cellViews?: EditorView[] }
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
    return wrap
  }
  // Own-commit re-render → keep DOM (focus/IME of nested cell views survive);
  // otherwise (undo / external edit) let CM rebuild.
  updateDOM(dom: HTMLElement) {
    return serialize(dom, this.delim) === this.source
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
