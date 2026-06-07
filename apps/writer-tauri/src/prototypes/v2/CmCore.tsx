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
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { cmPrototypeTheme } from '../cmTheme'
import { livePreviewV2 } from './livePreview'

const SAMPLE = `# Heading one
## Heading two

STEP 2 adds REVEAL: markers (#, **, *, ~~, backticks) hide when the caret is off
the construct and show raw when it's on. Try **bold**, *italic*, ~~strike~~, and
\`inline code\` — move the caret onto each and watch the markers appear/disappear.

Check: ① markers hide/show as the caret moves, ② arrow-keying across a hidden
marker feels OK (no atomic yet), and ③ 한글 입력(IME) inside **한글 굵게** is
still smooth (no freeze yet).

STEP 3a indents list lines (markers still raw):

- a bullet whose text is long enough to wrap, so we can confirm the second
  visual row lines up under the content rather than under the dash
- another bullet
  - a nested bullet (one more gutter of indent)
1. an ordered item
2. another ordered item
- [ ] a task item is still raw \`- [ ]\` text at this step
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
          // Minimal editing core (CM docs "getting started").
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          // CM draws its OWN caret/selection. Needed so the native caret doesn't
          // show as a stray horizontal bar during IME composition (the Korean
          // "가로 커서" artifact). The theme hides the native caret.
          drawSelection(),
          EditorView.lineWrapping,
          // Parse markdown for the syntax tree only — we render nothing from it
          // yet (no decorations at step 0). addKeymap:false so list/quote Enter
          // continuation isn't wired until we choose to.
          markdown({ extensions: [GFM], addKeymap: false }),
          livePreviewV2, // STEP 3a: + list layout (hanging indent; markers raw)
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
        CM Core (clean rewrite) — STEP 3a: list layout (hanging indent, markers raw)
      </div>
      <div className="cm-prototype" ref={hostRef} />
    </div>
  )
}
