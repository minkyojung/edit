// Regression: images are owned SOLELY by the block-decoration layer (v2/blocks),
// which replaces `![alt](url)` with the <img> widget. The live-preview inline layer
// must NOT also decorate an image's markers — Lezer parses an Image's `![`/`]`/`(`/`)`
// as the same LinkMark/URL node types a real link uses, so before the Image guard the
// generic LinkMark/URL branches hid/marked those markers too. Two layers decorating
// one image leaked stray brackets around the rendered image. This pins that
// live-preview emits ZERO decorations over a plain image line.

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { _buildDecos } from './livePreview'

// The exact shape that surfaced the bug: a plain image whose URL is percent-encoded
// (spaces + a narrow no-break space). Nothing about it should be link-decorated.
const LINE =
  '![Screenshot 2026-07-10 at 12.07.33 PM.png](images/Screenshot%202026-07-10%20at%2012.07.33%E2%80%AFPM.png)'
const DOC = `intro\n\n${LINE}\n\noutro`

function decosOverImage(caret: number) {
  const state = EditorState.create({
    doc: DOC,
    selection: { anchor: caret },
    extensions: [markdown({ extensions: [GFM] })],
  })
  const from = DOC.indexOf('![')
  const to = from + LINE.length
  // Only the decorations that fall on the image line.
  return _buildDecos(state, [{ from, to }]).filter((r) => r.from >= from && r.to <= to)
}

describe('image ownership — live-preview does not touch images', () => {
  it('emits no decorations over a plain image line (caret off it)', () => {
    expect(decosOverImage(0)).toHaveLength(0)
  })

  it('emits no decorations over a plain image line (caret on it)', () => {
    const onImage = DOC.indexOf('![') + 5
    expect(decosOverImage(onImage)).toHaveLength(0)
  })
})

// Same class as the image bug: a GFM table is replaced wholesale by the block table
// widget, but its CELLS can hold inline markdown (`**bold**`, `[x](u)`, `code`,
// `~~s~~`). Without a Table guard the inline layer decorated those cell markers too,
// colliding with the table widget. Pin that live-preview emits ZERO decorations over
// a table whose cells contain markdown.
const TABLE = '| **bold** | [x](u) |\n| --- | --- |\n| `code` | ~~s~~ |'
const TDOC = `intro\n\n${TABLE}\n\noutro`

function decosOverTable() {
  const state = EditorState.create({
    doc: TDOC,
    selection: { anchor: 0 },
    extensions: [markdown({ extensions: [GFM] })],
  })
  const from = TDOC.indexOf('|')
  const to = from + TABLE.length
  return _buildDecos(state, [{ from, to }]).filter((r) => r.from >= from && r.to <= to)
}

describe('table ownership — live-preview does not touch tables', () => {
  it('emits no decorations over a table with markdown-bearing cells', () => {
    expect(decosOverTable()).toHaveLength(0)
  })
})
