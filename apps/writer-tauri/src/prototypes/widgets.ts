// Replacing widgets for the CM Live Preview spike: image and GFM table.
// Throwaway quality — toDOM only. (Lists render as raw markdown text — no marker
// widgets.)

import { WidgetType } from '@codemirror/view'

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
  toDOM() {
    const img = document.createElement('img')
    img.className = 'cm-img'
    img.src = this.src
    img.alt = this.alt
    img.loading = 'lazy'
    return img
  }
  // Reuse the existing <img> when src changes — re-set in place. Setting src to the
  // same string is a no-op, so unrelated edits never reload the image.
  updateDOM(dom: HTMLElement) {
    const img = dom as HTMLImageElement
    img.src = this.src
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

export class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super()
  }
  eq(o: TableWidget) {
    return o.source === this.source
  }
  toDOM() {
    const rows = this.source
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('|') || l.includes('|'))
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
      cell.textContent = text
      if (aligns[i]) cell.style.textAlign = aligns[i]
    }
    let headerDone = false
    let body: HTMLTableSectionElement | null = null
    for (const line of rows) {
      if (isDelim(line)) continue
      if (!headerDone) {
        const thead = table.createTHead()
        const tr = thead.insertRow()
        cellsOf(line).forEach((c, i) => {
          const th = document.createElement('th')
          setCell(th, c, i)
          tr.appendChild(th)
        })
        headerDone = true
        continue
      }
      if (!body) body = table.createTBody()
      const tr = body.insertRow()
      cellsOf(line).forEach((c, i) => setCell(tr.insertCell(), c, i))
    }
    return table
  }
  get estimatedHeight() {
    return 120
  }
}
