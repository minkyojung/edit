// Replacing widgets for the CM Live Preview spike: image, task checkbox,
// list bullet, and GFM table. Throwaway quality — toDOM only, no interaction
// beyond what's needed to look right.

import { WidgetType, type EditorView } from '@codemirror/view'

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
  get estimatedHeight() {
    return 240
  }
}

export class CheckboxWidget extends WidgetType {
  // `pos` is the offset of the status char between the brackets (`[ ]` → the
  // space/`x`), so a click can flip just that one character.
  constructor(
    readonly checked: boolean,
    readonly pos: number,
  ) {
    super()
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked && o.pos === this.pos
  }
  toDOM(view: EditorView) {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-checkbox'
    box.checked = this.checked
    // Toggle the source `[ ]`↔`[x]` on click (Ixora's interactive-checkbox
    // pattern). The widget is atomic, so the click never lands a caret inside.
    box.addEventListener('click', () => {
      view.dispatch({
        changes: { from: this.pos, to: this.pos + 1, insert: this.checked ? ' ' : 'x' },
      })
    })
    return box
  }
  ignoreEvent() {
    return false
  }
}

export class BulletWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    const s = document.createElement('span')
    s.className = 'cm-bullet'
    s.textContent = '• '
    return s
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
