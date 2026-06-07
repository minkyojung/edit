// Clean rewrite of the CodeMirror live-preview spike, built minimally from the
// CM6 docs (codemirror.net/docs). Reachable at #/dev/cm2.
//
// STEP 0 — the FOUNDATION: a bare editor with NO live-preview decorations. The
// only goal is to confirm that plain typing, the caret, and Korean/CJK IME
// composition feel smooth on a minimal, fully-understood setup BEFORE any
// decoration layer is added. Everything from the old prototype (decorations,
// reveal, cards, IME-freeze hacks, atomic ranges) is intentionally absent and
// will be re-introduced one verified layer at a time.
//
// Deliberately NOT using `basicSetup` — it bundles line numbers + a fold gutter,
// which are wrong for a prose editor. We hand-pick the minimal extension set.

import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, drawSelection } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { indentUnit } from '@codemirror/language'
import { markdown, insertNewlineContinueMarkup, deleteMarkupBackward } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { cmPrototypeTheme } from '../cmTheme'
import { livePreviewV2 } from './livePreview'
import { imeListContinue } from '../imeListContinue'

const SAMPLE = `# Heading one
## Heading two

LIST EDITING (markers stay RAW — no bullets drawn). The point of this step is the
*behavior*, via CM's own markdown commands:
- type \`- \` then text, press ENTER → a new \`- \` continues automatically
- press ENTER on an empty item → it exits the list
- BACKSPACE at an item's start → removes the marker / dedents
- TAB / SHIFT-TAB → indent / outdent (nesting)

Try it here:

- first item (press Enter at the end of this line)
- second item
1. ordered one (Enter continues as 2.)

Does it FEEL like a list to edit, the way the old editor did — even without the •?
(Headings/bold reveal still work; 한글 IME too.)
`

export default function CmCore() {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const parent = hostRef.current
    if (!parent) return
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: SAMPLE,
        extensions: [
          // Minimal editing core (CM docs "getting started") + the markdown LIST
          // editing keymap (CM's own commands): Enter continues a list/quote item
          // (and exits on an empty one), Backspace at item start removes the
          // marker / dedents, Tab indents. This is the "behaves like a list" layer
          // — markers stay raw; rendering is a separate concern.
          history(),
          // Safari/WKWebView drops the Enter that confirms an IME composition, so
          // a Korean list item + Enter wouldn't continue the list. Recover it from
          // the browser's own beforeinput (insertParagraph/insertLineBreak) signal.
          imeListContinue(),
          indentUnit.of('  '), // 2-space nesting
          keymap.of([
            { key: 'Enter', run: insertNewlineContinueMarkup },
            { key: 'Backspace', run: deleteMarkupBackward },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          // CM draws its OWN caret/selection. Needed so the native caret doesn't
          // show as a stray horizontal bar during IME composition (the Korean
          // "가로 커서" artifact). The theme hides the native caret.
          drawSelection(),
          EditorView.lineWrapping,
          // Parse markdown for the syntax tree only — we render nothing from it
          // yet (no decorations at step 0). addKeymap:false so list/quote Enter
          // continuation isn't wired until we choose to.
          markdown({ extensions: [GFM], addKeymap: false }),
          livePreviewV2, // heading + emphasis reveal (lists are RAW text here)
          cmPrototypeTheme,
        ],
      }),
    })
    return () => view.destroy()
  }, [])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        overflow: 'auto',
        background: 'var(--background)',
        color: 'var(--foreground)',
      }}
    >
      <div
        style={{
          padding: '10px 16px',
          fontSize: 13,
          color: 'var(--muted-foreground)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        CM Core (clean rewrite) — list EDITING keymap (markers raw)
      </div>
      <div className="cm-prototype" ref={hostRef} />
    </div>
  )
}
