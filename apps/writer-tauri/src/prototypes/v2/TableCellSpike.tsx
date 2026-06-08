// SPIKE — Obsidian-1.5-style IN-PLACE table cell editing (de-risk). Reachable at
// #/dev/celledit.
//
// The table stays RENDERED as a real <table> (a CM6 block widget); each cell is
// `contenteditable`, edited directly — NO raw-markdown reveal. The point is to
// answer three make-or-break questions before committing to this architecture:
//   ① Korean/CJK IME — clean inside a contenteditable cell?
//   ② Sync — does the edit reach the markdown doc?
//   ③ Undo — does Cmd-Z revert a cell edit?
//
// Why it can work (verified in @codemirror/view source): CM's DOMObserver
// `readMutation` returns null for any mutation whose nearest tile `isWidget()`, so
// CM never tries to read or reset the contenteditable cell — the browser owns the
// editing + IME. We sync ourselves on `blur` (composition is already finished then)
// by serializing the table DOM and dispatching ONE transaction → native CM undo.
// `ignoreEvent() = true` keeps CM from handling the cell's events.

import { useEffect, useRef } from 'react'
import { EditorState, StateField, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, keymap, drawSelection, type DecorationSet } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'
import { GFM } from '@lezer/markdown'
import { cmPrototypeTheme } from '../cmTheme'

const isDelim = (line: string): boolean => /^[\s|:-]+$/.test(line) && line.includes('-')
const cellsOf = (line: string): string[] =>
  line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())

/** Re-serialize a rendered table's DOM back to GFM source, reusing the original
 * delimiter line (alignment is not editable in this spike). Single-space cell
 * padding so it round-trips with what we render. */
function serialize(root: HTMLElement, delim: string): string {
  const table = (root.querySelector('table') ?? root) as HTMLTableElement
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`
  const header = [...(table.tHead?.rows[0]?.cells ?? [])].map((c) => c.textContent?.trim() ?? '')
  const bodyRows = [...(table.tBodies[0]?.rows ?? [])].map((tr) =>
    [...tr.cells].map((c) => c.textContent?.trim() ?? ''),
  )
  return [line(header), delim, ...bodyRows.map(line)].join('\n')
}

class EditableTableWidget extends WidgetType {
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

    // Commit: serialize the DOM → if it differs from the doc, dispatch ONE
    // transaction replacing the table's range. Runs on blur (composition done) so
    // the re-render can't interrupt an active IME.
    //
    // The range [from, to] is derived from the LIVE document at call time, NOT from
    // `this.source.length`: when `updateDOM` keeps the DOM across a commit, the
    // cell's listeners still close over the OLD widget (stale source length), so a
    // captured length would mis-target the replace and leave a stray `|` that
    // re-parses into an extra cell (cells multiplying "one by one").
    const commit = () => {
      const next = serialize(table, this.delim)
      const from = view.posAtDOM(table)
      let node = syntaxTree(view.state).resolveInner(from, 1)
      while (node && node.name !== 'Table') node = node.parent as typeof node
      const to = node
        ? view.state.doc.lineAt(Math.min(node.to, view.state.doc.length)).to
        : from + this.source.length
      if (view.state.doc.sliceString(from, to) === next) return
      view.dispatch({ changes: { from, to, insert: next } })
    }

    // Keyboard navigation between cells (in-place makes this just focus movement).
    // `grid[visualRow][col]` — header is row 0, body rows follow (delimiter is not
    // rendered). focusCell selects the cell's contents (spreadsheet-style).
    const grid: HTMLTableCellElement[][] = []
    const focusCell = (cell: HTMLTableCellElement) => {
      cell.focus()
      const range = document.createRange()
      range.selectNodeContents(cell)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
    const nav = (cell: HTMLTableCellElement, dir: 'next' | 'prev' | 'down') => {
      let r = -1
      let c = -1
      for (let i = 0; i < grid.length && r < 0; i++) {
        const j = grid[i].indexOf(cell)
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
      const target = flat[flat.indexOf(cell) + (dir === 'next' ? 1 : -1)]
      if (target) focusCell(target)
    }

    const wireCell = (cell: HTMLTableCellElement, text: string) => {
      cell.textContent = text
      cell.contentEditable = 'true'
      cell.spellcheck = false
      cell.addEventListener('blur', commit)
      cell.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault()
          nav(cell, e.shiftKey ? 'prev' : 'next')
        } else if (e.key === 'Enter') {
          e.preventDefault() // never insert a newline into a cell
          nav(cell, 'down')
        } else if (e.key === 'Escape') {
          e.preventDefault()
          cell.blur()
        }
      })
    }

    // Per-column alignment from the delimiter (`:--` left, `:-:` center, `--:`
    // right) — applied as inline text-align, same as the cm2 table.
    const aligns = cellsOf(this.delim).map((c) => {
      const l = c.startsWith(':')
      const r = c.endsWith(':')
      return l && r ? 'center' : r ? 'right' : l ? 'left' : ''
    })

    let headerDone = false
    let body: HTMLTableSectionElement | null = null
    for (const line of rows) {
      if (isDelim(line)) continue
      const rowCells: HTMLTableCellElement[] = []
      if (!headerDone) {
        const tr = table.createTHead().insertRow()
        cellsOf(line).forEach((c, i) => {
          const th = document.createElement('th')
          wireCell(th, c)
          if (aligns[i]) th.style.textAlign = aligns[i]
          tr.appendChild(th)
          rowCells.push(th)
        })
        headerDone = true
      } else {
        if (!body) body = table.createTBody()
        const tr = body.insertRow()
        cellsOf(line).forEach((c, i) => {
          const td = tr.insertCell()
          wireCell(td, c)
          if (aligns[i]) td.style.textAlign = aligns[i]
          rowCells.push(td)
        })
      }
      grid.push(rowCells)
    }
    return table
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

function build(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = []
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'Table') return undefined
      const from = state.doc.lineAt(node.from).from
      const to = state.doc.lineAt(Math.min(node.to, state.doc.length)).to
      out.push(
        Decoration.replace({ widget: new EditableTableWidget(state.doc.sliceString(from, to)), block: true }).range(
          from,
          to,
        ),
      )
      return false
    },
  })
  return Decoration.set(out, true)
}

const tableField = StateField.define<DecorationSet>({
  create: (state) => build(state),
  // Always rendered (no reveal). Map across edits; rebuild only on doc change.
  update: (value, tr) => (tr.docChanged ? build(tr.state) : value),
  provide: (f) => EditorView.decorations.from(f),
})

const editableTables: Extension = tableField

const SAMPLE = `# In-place table cell editing (spike)

Click a cell and type — the table stays rendered (no raw markdown). Try Korean
(한글) inside a cell, then click outside to commit. Cmd-Z should undo the edit.

| Name | KR | Note |
| :--- | :---: | --- |
| Alpha | 가 | first |
| Beta | 나 | second |

Text below the table — normal editing here.
`

export default function TableCellSpike() {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const parent = hostRef.current
    if (!parent) return
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: SAMPLE,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          drawSelection(),
          EditorView.lineWrapping,
          markdown({ extensions: [GFM], addKeymap: false }),
          editableTables,
          cmPrototypeTheme,
        ],
      }),
    })
    return () => view.destroy()
  }, [])
  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'auto', background: 'var(--background)', color: 'var(--foreground)' }}>
      <div style={{ padding: '10px 16px', fontSize: 13, color: 'var(--muted-foreground)', borderBottom: '1px solid var(--border)' }}>
        TABLE CELL SPIKE — in-place contenteditable cells (IME / sync / undo de-risk)
      </div>
      <div className="cm-prototype" ref={hostRef} />
    </div>
  )
}
