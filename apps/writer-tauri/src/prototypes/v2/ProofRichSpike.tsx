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
import { proofMarks, addSuggestion, seedSuggestion } from './proofMarks'

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
          proofMarks, // ← suggestion marks layered on top
          cmPrototypeTheme,
        ],
      }),
    })
    // Seed AI-style suggestions over DIFFERENT markdown contexts: plain prose, inside
    // bold, inside a list item, inside a heading-ish line, inside a blockquote.
    const doc = view.state.doc.toString()
    const seeds = [
      seedSuggestion(doc, 'dependable', 'reliable', 'p1'), // plain prose
      seedSuggestion(doc, 'fast', 'quick', 'p2'), // inside **bold**
      seedSuggestion(doc, 'clearly', 'plainly', 'p3'), // inside a bullet list item
      seedSuggestion(doc, 'notable', 'striking', 'p4'), // inside a blockquote
    ].filter((s) => s != null)
    view.dispatch({
      effects: seeds.map((s) => addSuggestion.of(s)),
      annotations: Transaction.addToHistory.of(false),
    })
    return () => view.destroy()
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
