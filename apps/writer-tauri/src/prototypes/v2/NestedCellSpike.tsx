// SPIKE — the ONE make-or-break test for "rich table cells" (Approach B): does a
// NESTED CodeMirror EditorView, living inside a block widget inside the parent
// editor, handle Korean/CJK IME cleanly? CM6 uses the EditContext API by default,
// and two nested EditContext editors sharing a focus tree is the least-tested path.
// Reachable at #/dev/nestedcell.
//
// If Korean composition is clean here (no box/duplication) AND `livePreviewV2`
// renders inline marks + multiline + undo work inside the box → Approach B is GO.
// If IME breaks → fall back to Approach C (render only on blur).

import { useEffect, useRef } from 'react'
import { EditorState, StateField, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, keymap, drawSelection, type DecorationSet } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { cmPrototypeTheme } from '../cmTheme'
import { livePreviewV2 } from './livePreview'

// Neutralize the prose theme's huge page padding for the tiny nested view.
const cellTheme = EditorView.theme({
  '&': { fontSize: 'inherit' },
  '.cm-content': { maxWidth: 'none', margin: '0', padding: '6px 8px', caretColor: 'transparent' },
  '.cm-scroller': { lineHeight: '1.5' },
})

type WithView = HTMLElement & { _inner?: EditorView }

class NestedCellWidget extends WidgetType {
  constructor(readonly seed: string) {
    super()
  }
  eq(o: NestedCellWidget) {
    return o.seed === this.seed
  }
  toDOM() {
    const box = document.createElement('div') as WithView
    box.className = 'cm-nested-cell'
    box.style.cssText =
      'border:1px solid var(--info);border-radius:6px;max-width:420px;margin:4px 0;' +
      'background:color-mix(in oklch, var(--info) 6%, transparent);'
    // The nested editor — SAME live-preview engine as the main editor, so inline
    // render + multiline + IME come from code we already ship.
    const inner = new EditorView({
      parent: box,
      state: EditorState.create({
        doc: this.seed,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          drawSelection(),
          EditorView.lineWrapping,
          markdown({ extensions: [GFM], addKeymap: false }),
          livePreviewV2,
          cmPrototypeTheme,
          cellTheme,
        ],
      }),
    })
    box._inner = inner
    return box
  }
  // CM does NOT auto-destroy nested views — release it ourselves.
  destroy(dom: HTMLElement) {
    ;(dom as WithView)._inner?.destroy()
  }
  ignoreEvent() {
    return true
  }
  get estimatedHeight() {
    return 60
  }
}

const SEED = '**bold** and a [link](https://x.com)\nsecond line — type 한글 here'

function build(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = []
  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i)
    if (line.text.trim() === '[[CELL]]') {
      out.push(Decoration.replace({ widget: new NestedCellWidget(SEED), block: true }).range(line.from, line.to))
    }
  }
  return Decoration.set(out, true)
}

// Build once; MAP across edits so the widget (and its live nested editor) survives
// typing elsewhere instead of being rebuilt.
const nestedField = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update: (value, tr) => (tr.docChanged ? value.map(tr.changes) : value),
  provide: (f) => EditorView.decorations.from(f),
})

const nestedCell: Extension = nestedField

const SAMPLE = `# Nested-cell IME spike

The blue box below is a SEPARATE CodeMirror editor nested inside a widget. This
is the one test that decides "rich table cells": type Korean in it and watch the
composition.

CHECK inside the box:
- 한글 조합 — no box / no duplicated glyphs ("가나다" stays clean)
- \`**bold**\` renders bold, the link renders (livePreviewV2 works in the nest)
- Enter makes a new line (multiline), Cmd-Z undoes inside the box
- Click in/out, type in the parent text too — both should stay independent

[[CELL]]

Normal parent text — edit here freely; the box should keep its content + caret.
`

export default function NestedCellSpike() {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const parent = hostRef.current
    if (!parent) return
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: SAMPLE,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          drawSelection(),
          EditorView.lineWrapping,
          markdown({ extensions: [GFM], addKeymap: false }),
          nestedCell,
          cmPrototypeTheme,
        ],
      }),
    })
    return () => view.destroy()
  }, [])
  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'auto', background: 'var(--background)', color: 'var(--foreground)' }}>
      <div style={{ padding: '10px 16px', fontSize: 13, color: 'var(--muted-foreground)', borderBottom: '1px solid var(--border)' }}>
        NESTED-CELL SPIKE — does IME survive a CodeMirror inside a CodeMirror?
      </div>
      <div className="cm-prototype" ref={hostRef} />
    </div>
  )
}
