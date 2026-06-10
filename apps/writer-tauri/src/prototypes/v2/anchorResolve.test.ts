import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { resolveAnchors, naiveMatch } from './anchorResolve'

const DOC = `# anchor title

The anchor holds.

- list anchor item

> quote anchor here

| Concept | Status |
| :-- | :-- |
| anchor | solid |

\`\`\`ts
const anchor = 1
\`\`\`
`

const mk = (text: string) => EditorState.create({ doc: text, extensions: [markdown({ extensions: [GFM] })] })

describe('resolveAnchors (structural disambiguation)', () => {
  it('finds every occurrence tagged with its structural context', () => {
    const anchors = resolveAnchors(mk(DOC), 'anchor')
    const ctxs = anchors.map((a) => a.context)
    // heading, paragraph, list item, blockquote, table cell, code block
    expect(anchors.length).toBe(6)
    expect(ctxs).toContain('heading')
    expect(ctxs).toContain('paragraph')
    expect(ctxs).toContain('list item')
    expect(ctxs).toContain('blockquote')
    expect(ctxs).toContain('table cell')
    expect(ctxs).toContain('code block')
  })

  it('list-item / blockquote matches beat the generic paragraph they nest in', () => {
    const byLine = (n: number) => resolveAnchors(mk(DOC), 'anchor').find((a) => a.lineNo === n)
    expect(byLine(5)?.context).toBe('list item') // "- list anchor item"
    expect(byLine(7)?.context).toBe('blockquote') // "> quote anchor here"
  })

  it('each anchor carries an exact range that slices back to the needle', () => {
    const st = mk(DOC)
    for (const a of resolveAnchors(st, 'anchor')) {
      expect(st.doc.sliceString(a.from, a.to)).toBe('anchor')
    }
  })
})

describe('naiveMatch (production text-search behaviour)', () => {
  it('REFUSES the ambiguous case CM resolves precisely', () => {
    const r = naiveMatch(mk(DOC), 'anchor')
    expect(r.ok).toBe(false)
    expect(r.count).toBe(6)
    expect(r.reason).toMatch(/ambiguous/)
  })

  it('accepts a genuinely unique string', () => {
    const r = naiveMatch(mk(DOC), 'holds')
    expect(r.ok).toBe(true)
    expect(r.count).toBe(1)
  })
})
