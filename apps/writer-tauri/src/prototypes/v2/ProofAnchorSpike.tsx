// SPIKE — the AI-editing thesis, made visible. Reachable at #/dev/proofanchor.
//
// Same input the production assistant sends: { old_string, new_string }. We show two
// resolvers side by side:
//   • PRODUCTION (text search): counts matches; >1 ⇒ "ambiguous, refused" — the edit
//     simply fails today.
//   • CODEMIRROR (syntax tree): every occurrence resolved to an EXACT range tagged
//     with its structural context (heading / table cell / list item / …), so each can
//     be targeted precisely — and the context is exactly what we could hand back to
//     the assistant so it can say "the one in the table".
// Applying lands a real proof suggestion at the chosen range; it then tracks edits
// exactly (the tracking proof from #/dev/proofmark).

import { useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, drawSelection } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { cmPrototypeTheme } from '../cmTheme'
import { proofMarks, addSuggestion, type Suggestion } from './proofMarks'
import { resolveAnchors, naiveMatch, type Anchor } from './anchorResolve'

// Raw markdown on purpose (no block widgets): you SEE the `#`, `-`, `>`, `|`, ``` `` ``
// around each "anchor", so the structural labels line up with what's on screen.
const SAMPLE = `# anchor title

The anchor holds steady as the document grows around it.

## Checklist

- verify the anchor survives edits
- ship it

> a quote that mentions the anchor once more

| Concept | Status |
| :-- | :-- |
| anchor | solid |
| drift  | none  |

\`\`\`ts
const anchor = computeOffset()
\`\`\`
`

const CTX_TINT: Record<string, string> = {
  heading: '#e67e22',
  paragraph: 'var(--muted-foreground)',
  'list item': '#3498db',
  blockquote: '#9b59b6',
  'table cell': '#2ecc71',
  'code block': '#e74c3c',
}

export default function ProofAnchorSpike() {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const idRef = useRef(0)
  const [oldStr, setOldStr] = useState('anchor')
  const [newStr, setNewStr] = useState('anchor point')
  const [anchors, setAnchors] = useState<Anchor[]>([])
  const [naive, setNaive] = useState<ReturnType<typeof naiveMatch> | null>(null)

  const resolve = () => {
    const view = viewRef.current
    if (!view) return
    setAnchors(resolveAnchors(view.state, oldStr))
    setNaive(naiveMatch(view.state, oldStr))
  }

  const applyAt = (a: Anchor) => {
    const view = viewRef.current
    if (!view) return
    const s: Suggestion = { id: `a${idRef.current++}`, from: a.from, to: a.to, after: newStr, layout: 'inline' }
    view.dispatch({ effects: addSuggestion.of(s) })
    resolve() // ranges shifted by nothing here (effect only), but refresh labels/positions
    view.focus()
  }

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
          proofMarks,
          cmPrototypeTheme,
        ],
      }),
    })
    viewRef.current = view
    setAnchors(resolveAnchors(view.state, 'anchor'))
    setNaive(naiveMatch(view.state, 'anchor'))
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [])

  const label = { fontSize: 12, color: 'var(--muted-foreground)' }
  const input = {
    background: 'var(--background)',
    color: 'var(--foreground)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '4px 8px',
    font: 'inherit',
    width: '100%',
  } as const

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--background)', color: 'var(--foreground)' }}>
      <div style={{ padding: '10px 16px', fontSize: 13, color: 'var(--muted-foreground)', borderBottom: '1px solid var(--border)' }}>
        ANCHOR SPIKE — text search (refuses ambiguity) vs syntax-tree (resolves by structure)
      </div>
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div className="cm-prototype" ref={hostRef} style={{ flex: 1, overflow: 'auto', borderRight: '1px solid var(--border)' }} />
        <div style={{ width: 380, padding: 16, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* The assistant's input, verbatim. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={label}>AI proposes (old_string → new_string)</span>
            <input style={input} value={oldStr} onChange={(e) => setOldStr(e.target.value)} placeholder="old_string" />
            <input style={input} value={newStr} onChange={(e) => setNewStr(e.target.value)} placeholder="new_string" />
            <button
              type="button"
              onClick={resolve}
              style={{ ...input, width: 'auto', alignSelf: 'flex-start', cursor: 'pointer', background: 'var(--muted)' }}
            >
              Resolve
            </button>
          </div>

          {/* Production verdict. */}
          {naive && (
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
              <div style={{ ...label, marginBottom: 4 }}>Production · text search</div>
              <div style={{ fontSize: 14, color: naive.ok ? '#2ecc71' : 'var(--destructive, crimson)' }}>
                {naive.ok ? '✓' : '✗'} {naive.count} match{naive.count === 1 ? '' : 'es'} — {naive.reason}
              </div>
              {!naive.ok && naive.count > 1 && (
                <div style={{ ...label, marginTop: 4 }}>The edit cannot be placed — the assistant's quote is dropped.</div>
              )}
            </div>
          )}

          {/* CodeMirror verdict — every occurrence, resolved + targetable. */}
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
            <div style={{ ...label, marginBottom: 8 }}>CodeMirror · syntax tree</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {anchors.length === 0 && <div style={label}>no matches</div>}
              {anchors.map((a) => (
                <div key={`${a.from}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: CTX_TINT[a.context] ?? 'var(--foreground)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {a.context}
                  </span>
                  <span style={{ ...label, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    L{a.lineNo}: {a.lineText.trim()}
                  </span>
                  <button
                    type="button"
                    onClick={() => applyAt(a)}
                    style={{ ...input, width: 'auto', padding: '2px 8px', cursor: 'pointer', background: 'var(--muted)', fontSize: 12 }}
                  >
                    Apply here
                  </button>
                </div>
              ))}
            </div>
            <div style={{ ...label, marginTop: 8 }}>
              Each row is an EXACT range + the structural context we could hand the assistant to target with.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
