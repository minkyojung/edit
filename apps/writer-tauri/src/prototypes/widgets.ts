// Replacing widgets for the CM Live Preview spike: image and GFM table.
// Throwaway quality — toDOM only. (Lists render as raw markdown text — no marker
// widgets.)

import { WidgetType, type EditorView } from '@codemirror/view'
import { addRow, addColumn, deleteRow, deleteColumn, applyContentColumns } from './tableEdit'
import { setVaultAssetSrc } from './setAssetSrc'

export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super()
  }
  eq(o: ImageWidget) {
    return o.src === this.src && o.alt === this.alt
  }
  toDOM(view: EditorView) {
    const img = document.createElement('img')
    img.className = 'cm-img'
    setVaultAssetSrc(img, this.src) // resolve vault-relative paths to asset:// URLs
    img.alt = this.alt
    img.loading = 'lazy'
    // The image loads asynchronously, so its real height only appears AFTER CM has
    // already measured this line at the placeholder/estimated height. Tell CM to
    // re-measure once it loads so the heightmap matches what's on screen — without
    // this, clicks and up/down-arrow map to the wrong line (stale heightmap). This
    // is the canonical way to handle a widget whose height settles late.
    img.addEventListener('load', () => view.requestMeasure())
    return img
  }
  // Reuse the existing <img> when src changes — re-set in place. Setting src to the
  // same string is a no-op, so unrelated edits never reload the image.
  updateDOM(dom: HTMLElement) {
    const img = dom as HTMLImageElement
    setVaultAssetSrc(img, this.src)
    img.alt = this.alt
    return true
  }
  // TRUE → the editor ignores events from this widget (same as the media card):
  // clicking does nothing, no selection/border. To move the image, reveal the raw
  // `![...]()` source (arrow a caret onto it) and drag that text — like Obsidian.
  ignoreEvent() {
    return true
  }
  get estimatedHeight() {
    return 240
  }
}

// Minimal inline-markdown → DOM for table cells: `code`, **bold**, *italic*,
// ~~strike~~, [text](url). A single left-to-right pass over a small pattern set
// (bold before italic so `**x**` wins). Built as real DOM nodes (never innerHTML)
// so cell content can't inject markup. Not a full CommonMark parser (no nesting) —
// enough for table cells, and revealing the raw source is always the fallback.
export function renderInline(text: string): Node[] {
  const out: Node[] = []
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|~~([^~]+)~~|\[([^\]]+)\]\(([^)\s]+)\)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)))
    if (m[1] !== undefined) {
      const el = document.createElement('code')
      el.className = 'cm-inline-code'
      el.textContent = m[1]
      out.push(el)
    } else if (m[2] !== undefined) {
      const el = document.createElement('strong')
      el.textContent = m[2]
      out.push(el)
    } else if (m[3] !== undefined) {
      const el = document.createElement('em')
      el.textContent = m[3]
      out.push(el)
    } else if (m[4] !== undefined) {
      const el = document.createElement('del')
      el.textContent = m[4]
      out.push(el)
    } else {
      // [text](url) → styled like a link but NOT a navigable <a> (clicking an
      // <a href> would navigate the Tauri webview away from the app); reveal the
      // raw source to edit/open.
      const el = document.createElement('span')
      el.className = 'cm-link'
      el.textContent = m[5]
      out.push(el)
    }
    last = re.lastIndex
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)))
  return out
}

export class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super()
  }
  eq(o: TableWidget) {
    return o.source === this.source
  }
  toDOM(view: EditorView) {
    const rows = this.source
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('|') || l.includes('|'))

    // Wrapper = positioning context for the hover controls. Every control rewrites
    // the table SOURCE (the doc text is the source of truth) and dispatches it; the
    // decoration re-renders. The widget's current doc range is [from, from+length] —
    // `from` via posAtDOM on the wrapper at click time, so it survives edits above.
    // stopPropagation keeps a control click from reaching the cell-reveal handler.
    const wrap = document.createElement('div')
    wrap.className = 'cm-table-wrap'
    const rewrite = (fn: (src: string) => string) => (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const from = view.posAtDOM(wrap)
      view.dispatch({ changes: { from, to: from + this.source.length, insert: fn(this.source) } })
    }
    const ctrl = (
      cls: string,
      glyph: string,
      label: string,
      fn: (src: string) => string,
    ): HTMLButtonElement => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = cls
      b.textContent = glyph
      b.setAttribute('aria-label', label)
      b.addEventListener('mousedown', rewrite(fn))
      return b
    }

    const table = document.createElement('table')
    table.className = 'cm-md-table'
    const cellsOf = (line: string) =>
      line
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim())
    const isDelim = (line: string) => /^[\s|:-]+$/.test(line) && line.includes('-')
    // Per-column alignment from the GFM delimiter row: a leading colon = left,
    // trailing = right, both = center, none = default (left via CSS). Applied as
    // inline text-align on every cell in that column.
    const delim = rows.find(isDelim)
    const aligns: string[] = delim
      ? cellsOf(delim).map((c) => {
          const l = c.startsWith(':')
          const r = c.endsWith(':')
          return l && r ? 'center' : r ? 'right' : l ? 'left' : ''
        })
      : []
    const setCell = (cell: HTMLTableCellElement, text: string, i: number) => {
      cell.append(...renderInline(text))
      if (aligns[i]) cell.style.textAlign = aligns[i]
    }
    let headerDone = false
    let body: HTMLTableSectionElement | null = null
    let dataIndex = -1
    for (const line of rows) {
      if (isDelim(line)) continue
      if (!headerDone) {
        const thead = table.createTHead()
        const tr = thead.insertRow()
        cellsOf(line).forEach((c, i) => {
          const th = document.createElement('th')
          setCell(th, c, i)
          // Per-column delete handle (above the column, hover-revealed).
          th.appendChild(ctrl('cm-table-delcol', '×', 'Delete column', (s) => deleteColumn(s, i)))
          tr.appendChild(th)
        })
        headerDone = true
        continue
      }
      if (!body) body = table.createTBody()
      const tr = body.insertRow()
      const di = ++dataIndex
      cellsOf(line).forEach((c, i) => {
        const td = tr.insertCell()
        setCell(td, c, i)
        // Per-row delete handle on the first cell (left of the row, hover-revealed).
        if (i === 0) td.appendChild(ctrl('cm-table-delrow', '×', 'Delete row', (s) => deleteRow(s, di)))
      })
    }

    // Full-width, content-proportional columns (shared with the editable renderer).
    applyContentColumns(table, this.source)
    wrap.appendChild(table)
    wrap.append(
      ctrl('cm-table-addcol', '+', 'Add column', addColumn),
      ctrl('cm-table-addrow', '+', 'Add row', addRow),
    )
    return wrap
  }
  // FALSE → clicks on the rendered table reach the editor's domEventHandlers. A
  // block widget is otherwise unreachable (the caret can't land in it and arrow
  // motion skips it), so the click handler in blocks.ts is the ONLY way to enter
  // the table for editing — it reveals the raw markdown at the clicked spot.
  ignoreEvent() {
    return false
  }
  get estimatedHeight() {
    return 120
  }
}
