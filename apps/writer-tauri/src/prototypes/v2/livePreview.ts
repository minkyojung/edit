// Clean live-preview decoration engine (v2). Built one verified layer at a time.
//
// STEP 1 — heading + emphasis STYLING only. We emit just two decoration kinds:
//   • line decorations  → heading lines get cm-h1..cm-h6 (font size/weight)
//   • mark decorations   → bold / italic / strike / inline-code get a class
// We do NOT hide any markers yet (the `#`, `**`, backticks stay visible) — that
// "reveal" behavior is step 2. Because there are NO replace/atomic decorations,
// a viewport ViewPlugin is legal here (CM forbids only block widgets and
// line-break-crossing replaces from plugins). No selection dependence, no IME
// freeze — added later only if observation shows they're needed.

import { syntaxTree } from '@codemirror/language'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { type EditorState, type Range } from '@codemirror/state'

function buildDecos(state: EditorState, ranges: readonly { from: number; to: number }[]): Range<Decoration>[] {
  const out: Range<Decoration>[] = []
  const tree = syntaxTree(state)
  const mark = (from: number, to: number, cls: string) => {
    if (to > from) out.push(Decoration.mark({ class: cls }).range(from, to))
  }
  for (const { from, to } of ranges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const { name } = node
        if (/^ATXHeading[1-6]$/.test(name)) {
          out.push(Decoration.line({ class: `cm-h${name.slice(-1)}` }).range(state.doc.lineAt(node.from).from))
          return
        }
        if (name === 'StrongEmphasis') mark(node.from, node.to, 'cm-strong')
        else if (name === 'Emphasis') mark(node.from, node.to, 'cm-em')
        else if (name === 'Strikethrough') mark(node.from, node.to, 'cm-strike')
        else if (name === 'InlineCode') mark(node.from, node.to, 'cm-inline-code')
      },
    })
  }
  return out
}

export const livePreviewV2 = ViewPlugin.fromClass(
  class {
    deco: DecorationSet
    constructor(view: EditorView) {
      this.deco = this.build(view)
    }
    build(view: EditorView): DecorationSet {
      return Decoration.set(buildDecos(view.state, view.visibleRanges), true)
    }
    update(u: ViewUpdate) {
      // No reveal yet → selection changes don't matter; rebuild only when the
      // doc or the visible range changes.
      if (u.docChanged || u.viewportChanged) this.deco = this.build(u.view)
    }
  },
  { decorations: (v) => v.deco },
)
