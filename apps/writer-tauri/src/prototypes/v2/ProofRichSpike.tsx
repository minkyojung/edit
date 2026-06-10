// SPIKE — proof/suggestion marks layered over the FULL markdown live-preview.
// Reachable at #/dev/proofrich.
//
// The proof spike (#/dev/proofmark) ran in a plain editor. Real AI suggestions land
// in a doc full of markdown styling + widgets (bold/headings/lists/tables/images).
// This verifies the two decoration layers COEXIST: both anchor on raw document
// positions and CM composes all decoration sources, so suggestions should render and
// track exactly the same, even over styled text.

import { useEffect, useRef } from 'react'
import { EditorState, Transaction } from '@codemirror/state'
import { EditorView, keymap, drawSelection, dropCursor } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { indentUnit } from '@codemirror/language'
import { markdown, insertNewlineContinueMarkup, deleteMarkupBackward } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { cmPrototypeTheme } from '../cmTheme'
import { livePreviewV2, taskCheckboxClick } from './livePreview'
import { blocksV2 } from './blocks'
import { tableArrowEntry } from './editableTable'
import { blockVerticalNav } from './blockVerticalNav'
import { proofMarks, addSuggestion, seedSuggestion, blockSuggestion } from './proofMarks'

const SAMPLE = `# Proof marks over full markdown

The CodeMirror editor is **fast** and dependable for daily writing. Move the caret
onto styled text to reveal the raw \`**markers**\`; the suggestions below should
still render and track over bold, lists, and headings.

## Things to verify

- Write clearly every single day
- [ ] Ship the migration spike
- [x] Prove the table works

> A blockquote with a notable phrase inside it.

| Feature | PM | CM |
| :--- | :---: | ---: |
| Anchor | yes | yes |

![A scenic placeholder](https://picsum.photos/480/240)

Edit anywhere — type before a suggestion, delete inside it — the strike/replace and
its ✓/✕ must follow exactly, alongside the markdown styling.
`

export default function ProofRichSpike() {
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
          indentUnit.of('  '),
          keymap.of([
            { key: 'Enter', run: insertNewlineContinueMarkup },
            { key: 'Backspace', run: deleteMarkupBackward },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          drawSelection(),
          dropCursor(),
          EditorView.lineWrapping,
          markdown({ extensions: [GFM], addKeymap: false }),
          taskCheckboxClick,
          livePreviewV2, // inline + line markdown styling
          blocksV2, // table / image / media widgets
          tableArrowEntry,
          blockVerticalNav, // correct ArrowUp/Down overshoot across stacked block widgets
          proofMarks, // ← suggestion marks layered on top
          cmPrototypeTheme,
        ],
      }),
    })
    // Seed AI-style suggestions over DIFFERENT markdown contexts: plain prose, inside
    // bold, inside a list item, inside a heading-ish line, inside a blockquote.
    const doc = view.state.doc.toString()
    // Anchor a block insertion at the END of the line containing `needle` (a line
    // boundary, where a block widget is allowed).
    const lineEndAfter = (needle: string): number | null => {
      const i = doc.indexOf(needle)
      return i < 0 ? null : view.state.doc.lineAt(i).to
    }
    const tablePos = lineEndAfter('Prove the table works')
    const seeds = [
      seedSuggestion(doc, 'dependable', 'reliable', 'p1'), // plain prose
      seedSuggestion(doc, 'fast', 'quick', 'p2'), // inside **bold**
      seedSuggestion(doc, 'clearly', 'plainly', 'p3'), // inside a bullet list item
      seedSuggestion(doc, 'notable', 'striking', 'p4'), // inside a blockquote
      // BLOCK suggestion — `after` previews as a real table, ✓ Insert drops the
      // markdown into the doc and blocksV2 renders it for real. (Media block
      // suggestions deferred: the preview tile needs styling work first.)
      tablePos == null
        ? null
        : blockSuggestion(
            tablePos,
            '\n\n| Quarter | Revenue |\n| :-- | --: |\n| Q1 | $1.2M |\n| Q2 | $1.8M |\n',
            'b1',
          ),
    ].filter((s) => s != null)
    view.dispatch({
      effects: seeds.map((s) => addSuggestion.of(s)),
      annotations: Transaction.addToHistory.of(false),
    })
    // A suggestion INSIDE a table cell can't be seeded on the outer doc: the table's
    // source range is replaced by the block widget, so an outer mark there is hidden.
    // Each cell is its OWN nested editor, though — and it now carries `proofMarks` too.
    // So we seed into the cell's LOCAL doc once the table has rendered.
    const seedInCell = () => {
      const wrap = view.dom.querySelector('.cm-table-wrap') as
        | (HTMLElement & { _cellViews?: import('@codemirror/view').EditorView[] })
        | null
      const cell = wrap?._cellViews?.find((cv) => cv.state.doc.toString().includes('Anchor'))
      if (!cell) return
      const s = seedSuggestion(cell.state.doc.toString(), 'Anchor', 'Re-anchor', 'c1')
      if (s) cell.dispatch({ effects: addSuggestion.of(s), annotations: Transaction.addToHistory.of(false) })
    }
    const raf = requestAnimationFrame(seedInCell)
    return () => {
      cancelAnimationFrame(raf)
      view.destroy()
    }
  }, [])
  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'auto', background: 'var(--background)', color: 'var(--foreground)' }}>
      <div style={{ padding: '10px 16px', fontSize: 13, color: 'var(--muted-foreground)', borderBottom: '1px solid var(--border)' }}>
        PROOF + MARKDOWN SPIKE — suggestions layered over the full live-preview
      </div>
      <div className="cm-prototype" ref={hostRef} />
    </div>
  )
}
