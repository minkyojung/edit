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

const SAMPLE = `# Clean start

Type here. This is plain markdown — there are NO live-preview decorations yet,
so markers like # and ** stay visible. That is expected at step 0.

The only thing to check: does typing feel right, does the caret sit correctly,
and is 한글 입력(IME 조합) smooth — no jumping, no duplication, no jitter?

- a list item is just raw text at this step
- another line, long enough to wrap so we can see soft-wrap behaves on this bare
  foundation before we add any list layout
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
        CM Core (clean rewrite) — STEP 0: bare editor, no decorations
      </div>
      <div className="cm-prototype" ref={hostRef} />
    </div>
  )
}
