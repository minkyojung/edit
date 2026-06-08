// In-place editable GFM table — a CM6 block widget rendering a real <table> whose
// cells are `contenteditable` (Obsidian-1.5 style). Edited directly, NO raw-markdown
// reveal. Shared by the spike (#/dev/celledit) and the cm2 editor.
//
// Why it works (verified in @codemirror/view): CM's DOMObserver `readMutation`
// returns null for mutations inside a widget tile, so the browser owns the cell's
// editing + IME natively. We sync on `blur` by serializing the table DOM into ONE
// transaction (native CM undo). `ignoreEvent()=true` keeps CM out of the cell's
// events. Cells show RAW markdown text (e.g. `**bold**`) — inline rendering inside
// an editable cell is a separate, deferred concern.

import { EditorView, WidgetType } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { addRow, addColumn, deleteRow, deleteColumn } from '../tableEdit'

const isDelim = (line: string): boolean => /^[\s|:-]+$/.test(line) && line.includes('-')
const cellsOf = (line: string): string[] =>
  line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())

/** Re-serialize a rendered table's DOM back to GFM source, reusing the original
 * delimiter line. Reads each cell's editable BODY only — never the cell's full
 * textContent, which would include the "×" delete handles rendered inside it. */
export function serialize(root: HTMLElement, delim: string): string {
  const table = (root.querySelector('table') ?? root) as HTMLTableElement
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`
  const text = (c: HTMLTableCellElement) => (c.querySelector('.cm-cell-body') ?? c).textContent?.trim() ?? ''
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

    // The table's CURRENT document range, from the live syntax tree — NOT from
    // `this.source.length`. When `updateDOM` keeps the DOM across a commit, the
    // cell's listeners still close over the OLD widget (stale length), so a captured
    // length would mis-target the replace and leave a stray `|` that re-parses into
    // an extra cell (cells multiplying "one by one").
    const rangeFromDoc = (): { from: number; to: number } => {
      const from = view.posAtDOM(table)
      let node = syntaxTree(view.state).resolveInner(from, 1)
      while (node && node.name !== 'Table') node = node.parent as typeof node
      const to = node
        ? view.state.doc.lineAt(Math.min(node.to, view.state.doc.length)).to
        : from + this.source.length
      return { from, to }
    }
    // Commit on blur (composition already finished) → one transaction.
    const commit = () => {
      const next = serialize(table, this.delim)
      const { from, to } = rangeFromDoc()
      if (view.state.doc.sliceString(from, to) === next) return
      view.dispatch({ changes: { from, to, insert: next } })
    }
    // Structural op (add/delete row/column): apply a kernel fn to the CURRENT table
    // source (serialized DOM, so unsaved cell edits are kept) and replace the live
    // range. Refocus the editor so Cmd-Z reaches CM history (ignoreEvent=true drops
    // the undo keypress while focus is inside the widget).
    const structOp = (fn: (src: string) => string) => (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const next = fn(serialize(table, this.delim))
      const { from, to } = rangeFromDoc()
      if (view.state.doc.sliceString(from, to) === next) return
      view.dispatch({ changes: { from, to, insert: next } })
      view.focus()
    }

    // Keyboard nav between cells = focus movement. `grid[row][col]` holds each cell's
    // editable BODY div. focusCell selects the body's contents (spreadsheet-style).
    const grid: HTMLElement[][] = []
    const focusCell = (el: HTMLElement) => {
      el.focus()
      const range = document.createRange()
      range.selectNodeContents(el)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
    const nav = (el: HTMLElement, dir: 'next' | 'prev' | 'down') => {
      let r = -1
      let c = -1
      for (let i = 0; i < grid.length && r < 0; i++) {
        const j = grid[i].indexOf(el)
        if (j >= 0) {
          r = i
          c = j
        }
      }
      if (r < 0) return
      if (dir === 'down') {
        const below = grid[r + 1]?.[c]
        if (below) focusCell(below)
        return
      }
      const flat = grid.flat()
      const target = flat[flat.indexOf(el) + (dir === 'next' ? 1 : -1)]
      if (target) focusCell(target)
    }

    // Cell text lives in a dedicated contenteditable body div — separate from the
    // cell so the "×" delete handle can sit in the cell without being part of the
    // editable text (serialize reads `.cm-cell-body` only). Returns the body.
    const wireCell = (cell: HTMLTableCellElement, text: string): HTMLElement => {
      const el = document.createElement('div')
      el.className = 'cm-cell-body'
      el.contentEditable = 'true'
      el.spellcheck = false
      el.textContent = text
      el.addEventListener('blur', commit)
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault()
          nav(el, e.shiftKey ? 'prev' : 'next')
        } else if (e.key === 'Enter') {
          e.preventDefault() // never insert a newline into a cell
          nav(el, 'down')
        } else if (e.key === 'Escape') {
          e.preventDefault()
          el.blur()
        }
      })
      cell.appendChild(el)
      return el
    }
    const delHandle = (cls: string, label: string, fn: (src: string) => string): HTMLButtonElement => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = cls
      b.textContent = '×'
      b.contentEditable = 'false'
      b.setAttribute('aria-label', label)
      b.addEventListener('mousedown', structOp(fn))
      return b
    }

    // Per-column alignment from the delimiter (`:--` left, `:-:` center, `--:` right).
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
      const rowCells: HTMLElement[] = []
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

    // Wrap so the hover "+" rails sit on the right (add column) / bottom (add row)
    // edges. Rails live OUTSIDE the cells, so their glyphs never pollute cell text.
    const wrap = document.createElement('div')
    wrap.className = 'cm-table-wrap'
    wrap.appendChild(table)
    const rail = (cls: string, label: string, fn: (src: string) => string) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = cls
      b.textContent = '+'
      b.setAttribute('aria-label', label)
      b.addEventListener('mousedown', structOp(fn))
      wrap.appendChild(b)
    }
    rail('cm-table-addcol', 'Add column', addColumn)
    rail('cm-table-addrow', 'Add row', addRow)
    return wrap
  }
  // If the existing DOM already serializes to our (new) source, this update was
  // caused by our OWN commit of the user's typing → keep the DOM so focus/IME
  // survive. Otherwise (e.g. an undo changed the source underneath) let CM rebuild.
  updateDOM(dom: HTMLElement) {
    return serialize(dom, this.delim) === this.source
  }
  ignoreEvent() {
    return true
  }
  get estimatedHeight() {
    return 120
  }
}
