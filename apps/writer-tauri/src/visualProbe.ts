// Headless visual probe (see visual-probe.html). Mounts the REAL editor styling stack
// on list fixtures and measures, for every VISUAL row of every line, the x where its
// first glyph starts — via view.coordsAtPos, i.e. the same DOM measurement CM itself
// uses. A headless browser dumps #out; misalignment shows up as differing x values
// where the design says they must be equal (first-row content vs wrapped rows vs
// continuation rows vs the empty-continuation caret).

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { forceParsing } from '@codemirror/language'
import { livePreviewV2 } from './editor/livepreview/livePreview'
import { cmPrototypeTheme } from './editor/theme/cmTheme'
import { spaceWidthProbe } from './editor/extensions/spaceWidth'

// Replica of CmEditor's layoutReset (the production default is text-align:justify —
// suspected of stretching spaces and breaking indent alignment, so it must be in the
// probe). `?align=left` overrides it for A/B comparison.
const align = new URLSearchParams(location.search).get('align') ?? 'justify'
const layoutReset = EditorView.theme({
  '.cm-content': {
    maxWidth: 'none',
    margin: '0',
    padding: '8px',
    textAlign: align,
  },
})

const DOC = [
  '- short item',
  '- this long list item definitely wraps around to more visual lines so wrapped row alignment is measurable',
  '- item with continuation',
  '  indented continuation content that is also long enough to wrap to another visual row for measuring',
  '  ', // empty continuation (what Shift+Enter leaves) — caret column is the bug
  // Korean: few spaces per row → justify concentrates its stretch on them (incl. our
  // leading indent spaces), the suspected source of the gross misalignment.
  '- 한국어 리스트 아이템은 공백이 적어서 저스티파이가 남는 공간을 몇 안 되는 공백에 몰아넣기 때문에 정렬이 크게 어긋날 수 있다',
  '  한국어 연속줄도 마찬가지로 공백이 적기 때문에 선행 공백 두 칸이 크게 늘어나면 본문 열에서 멀리 밀려난다',
  '',
  'plain paragraph for baseline comparison of the left margin position',
].join('\n')

const view = new EditorView({
  parent: document.querySelector('#host')!,
  state: EditorState.create({
    doc: DOC,
    extensions: [
      EditorView.lineWrapping,
      markdown({ extensions: [GFM], addKeymap: false }),
      livePreviewV2,
      Prec.lowest(cmPrototypeTheme),
      layoutReset,
    ],
  }),
})
// Force a full parse so livePreview's tree walk sees final structure (headless page,
// no user typing to trigger incremental parses).
forceParsing(view, view.state.doc.length, 5000)
// Match production: measure the space advance → --cm-space-w (the probe extension is a
// plugin; here we inline the same measurement so the probe page controls timing).
{
  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre'
  probe.textContent = ' '.repeat(50)
  view.scrollDOM.appendChild(probe)
  const w = probe.getBoundingClientRect().width / 50
  probe.remove()
  view.dom.style.setProperty('--cm-space-w', `${w}px`)
  ;(window as { __spaceW?: number }).__spaceW = w
}
void spaceWidthProbe // imported to ensure it compiles; production wiring is in CmEditor

interface Row {
  top: number
  left: number
  glyph: string
}

function measure() {
  const origin = view.contentDOM.getBoundingClientRect().left
  const lines: { text: string; rows: Row[]; caretX?: number }[] = []
  for (let ln = 1; ln <= view.state.doc.lines; ln++) {
    const line = view.state.doc.line(ln)
    const rows: Row[] = []
    let lastTop = -1e9
    for (let pos = line.from; pos <= line.to; pos++) {
      const c = view.coordsAtPos(pos, 1)
      if (!c) continue
      if (c.top > lastTop + 2) {
        rows.push({
          top: Math.round(c.top),
          left: Math.round((c.left - origin) * 10) / 10,
          glyph: view.state.doc.sliceString(pos, Math.min(pos + 12, line.to)),
        })
        lastTop = c.top
      }
    }
    const entry: { text: string; rows: Row[]; caretX?: number; contentX?: number } = { text: line.text, rows }
    // Where the CONTENT actually starts on the first row (after marker or after the
    // leading indent spaces) — the value that must equal the wrapped rows' left.
    const pm = /^(\s*)([-*+]|\d+[.)])\s/.exec(line.text)
    const contentPos = pm ? line.from + pm[0].length : line.from + (/^[ \t]*/.exec(line.text)?.[0].length ?? 0)
    if (contentPos > line.from && contentPos < line.to) {
      const cc = view.coordsAtPos(contentPos, 1)
      if (cc) entry.contentX = Math.round((cc.left - origin) * 10) / 10
    }
    // The empty-continuation caret column (end-of-line coords = where the caret sits).
    if (line.text.trim() === '' && line.length > 0) {
      const c = view.coordsAtPos(line.to, -1)
      if (c) entry.caretX = Math.round((c.left - origin) * 10) / 10
    }
    lines.push(entry)
  }
  return {
    align,
    spaceW: Math.round(((window as { __spaceW?: number }).__spaceW ?? 0) * 100) / 100,
    lines,
  }
}

// Fonts can swap after first paint; measure after they settle + one more frame.
document.fonts.ready.then(() => {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const result = measure()
      document.querySelector('#out')!.textContent = 'PROBE_JSON ' + JSON.stringify(result, null, 1)
    })
  })
})
