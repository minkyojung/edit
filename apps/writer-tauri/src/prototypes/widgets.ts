// Replacing widgets for the CM Live Preview spike: image and GFM table.
// Throwaway quality — toDOM only. (Lists render as raw markdown text — no marker
// widgets.)

import { WidgetType } from '@codemirror/view'

export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly selected = false, // block-selected (clicked) → draws a border
  ) {
    super()
  }
  eq(o: ImageWidget) {
    return o.src === this.src && o.alt === this.alt && o.selected === this.selected
  }
  toDOM() {
    const img = document.createElement('img')
    img.className = `cm-img${this.selected ? ' cm-block-selected' : ''}`
    img.src = this.src
    img.alt = this.alt
    img.loading = 'lazy'
    img.draggable = true // + ignoreEvent()=false → CM's built-in drag MOVES the source
    return img
  }
  // Reuse the existing <img> when only `selected` (or even src) changes — toggle
  // the class / re-set src in place. Setting src to the same string is a no-op,
  // so selecting/deselecting never reloads the image.
  updateDOM(dom: HTMLElement) {
    const img = dom as HTMLImageElement
    img.src = this.src
    img.alt = this.alt
    img.classList.toggle('cm-block-selected', this.selected)
    return true
  }
  // FALSE → the editor does NOT ignore events from this widget, so a click on the
  // <img> reaches our domEventHandlers (default is to ignore widget events).
  ignoreEvent() {
    return false
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
    let headerDone = false
    let body: HTMLTableSectionElement | null = null
    for (const line of rows) {
      if (isDelim(line)) continue
      if (!headerDone) {
        const thead = table.createTHead()
        const tr = thead.insertRow()
        for (const c of cellsOf(line)) {
          const th = document.createElement('th')
          th.textContent = c
          tr.appendChild(th)
        }
        headerDone = true
        continue
      }
      if (!body) body = table.createTBody()
      const tr = body.insertRow()
      for (const c of cellsOf(line)) {
        const td = tr.insertCell()
        td.textContent = c
      }
    }
    return table
  }
  get estimatedHeight() {
    return 120
  }
}
