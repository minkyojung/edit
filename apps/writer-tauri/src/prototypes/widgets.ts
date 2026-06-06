// Replacing widgets for the CM Live Preview spike: image, task checkbox,
// ordered-list number, and GFM table. Throwaway quality — toDOM only, no
// interaction beyond what's needed to look right.

import { WidgetType, type EditorView } from '@codemirror/view'

type CaretRect = { left: number; right: number; top: number; bottom: number }

// Caret rect for an EMPTY list line whose only inline content is an out-of-flow
// marker widget. By default CM6 measures the widget's OWN box — its right edge
// sits in the gutter (and its box height inflates the caret) — so the caret
// ignores the reserved content column. We instead report a zero-width caret at
// the line's content-box left (the `padding-inline-start` column) with the
// line's height, matching the bullet (::before) case. This is CM's sanctioned
// hook for out-of-flow widgets (codemirror/dev#1222). Returns null for the
// before-marker side so CM keeps its default there; when the item has text, a
// TextTile is measured instead and this never runs.
function caretAtContentColumn(dom: HTMLElement): CaretRect | null {
  const line = dom.closest('.cm-line') as HTMLElement | null
  if (!line) return null
  const lr = line.getBoundingClientRect()
  const cs = getComputedStyle(line)
  const x = lr.left + parseFloat(cs.borderLeftWidth || '0') + parseFloat(cs.paddingLeft || '0')
  return { left: x, right: x, top: lr.top, bottom: lr.bottom }
}

// Ordered-list marker (`1.`, `10.`…) rendered out-of-flow in the gutter, left-
// aligned by CSS. Non-interactive — the source number stays the source of truth.
export class OrderedMarkerWidget extends WidgetType {
  constructor(readonly label: string) {
    super()
  }
  eq(o: OrderedMarkerWidget) {
    return o.label === this.label
  }
  toDOM() {
    const s = document.createElement('span')
    s.className = 'cm-list-marker cm-list-num'
    s.textContent = this.label
    return s
  }
  coordsAt(dom: HTMLElement, _pos: number, side: number): CaretRect | null {
    return side < 0 ? null : caretAtContentColumn(dom)
  }
}

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
    // `cm-list-marker` positions it out-of-flow in the reserved gutter (like the
    // bullet); its fixed ~1em box keeps an empty task's caret from inflating.
    box.className = 'cm-list-marker cm-checkbox'
    box.checked = this.checked
    // Toggle the source `[ ]`↔`[x]`. Use `mousedown` + preventDefault: that
    // suppresses the browser's native focus+toggle so the dispatch is the SINGLE
    // source of truth (no double-flip), and — paired with `ignoreEvent()→true` —
    // the editor never starts a text selection on the click.
    box.addEventListener('mousedown', (e) => {
      e.preventDefault()
      view.dispatch({
        changes: { from: this.pos, to: this.pos + 1, insert: this.checked ? ' ' : 'x' },
      })
    })
    return box
  }
  // TRUE = the editor IGNORES events inside this widget (CM default), so a click
  // toggles via our listener without the editor placing/extending a selection.
  ignoreEvent() {
    return true
  }
  // Empty-task caret: land it at the content column, not the checkbox's gutter
  // edge (see caretAtContentColumn / codemirror/dev#1222).
  coordsAt(dom: HTMLElement, _pos: number, side: number): CaretRect | null {
    return side < 0 ? null : caretAtContentColumn(dom)
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
