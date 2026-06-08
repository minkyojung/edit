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
