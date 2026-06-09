// SPIKE — Obsidian-1.5-style IN-PLACE table cell editing. Reachable at
// #/dev/celledit. The editable table widget itself now lives in `editableTable.ts`
// (shared with the cm2 editor); this file is just the isolated harness.

import { useEffect, useRef } from 'react'
import { EditorState, StateField, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, keymap, drawSelection, type DecorationSet } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'
import { GFM } from '@lezer/markdown'
import { cmPrototypeTheme } from '../cmTheme'
import { EditableTableWidget, tableArrowEntry } from './editableTable'

function build(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = []
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'Table') return undefined
      const from = state.doc.lineAt(node.from).from
      const to = state.doc.lineAt(Math.min(node.to, state.doc.length)).to
      out.push(
        Decoration.replace({ widget: new EditableTableWidget(state.doc.sliceString(from, to)), block: true }).range(
          from,
          to,
        ),
      )
      return false
    },
  })
  return Decoration.set(out, true)
}

const tableField = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update: (value, tr) => (tr.docChanged ? build(tr.state) : value),
  provide: (f) => EditorView.decorations.from(f),
})

const editableTables: Extension = tableField

const SAMPLE = `# In-place table cell editing (spike)

Click a cell and type — the table stays rendered (no raw markdown). Try Korean
(한글) inside a cell, then click outside to commit. Cmd-Z should undo the edit.

| Name | KR | Note |
| :--- | :---: | --- |
| Alpha | 가 | first |
| Beta | 나 | second |

Text below the table — normal editing here.
`

export default function TableCellSpike() {
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
          editableTables,
          tableArrowEntry,
          cmPrototypeTheme,
        ],
      }),
    })
    return () => view.destroy()
  }, [])
  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'auto', background: 'var(--background)', color: 'var(--foreground)' }}>
      <div style={{ padding: '10px 16px', fontSize: 13, color: 'var(--muted-foreground)', borderBottom: '1px solid var(--border)' }}>
        TABLE CELL SPIKE — in-place contenteditable cells (now shared via editableTable.ts)
      </div>
      <div className="cm-prototype" ref={hostRef} />
    </div>
  )
}
