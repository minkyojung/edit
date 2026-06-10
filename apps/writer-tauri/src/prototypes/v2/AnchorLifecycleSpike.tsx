// SPIKE — suggestion lifecycle UX. Reachable at #/dev/anchorlife.
//
// Three states a real AI suggestion can be in, all visible at once:
//   • alive    — anchored in the doc (strike old + green new), Apply/Dismiss in panel
//   • stale    — you edited the quoted text → dimmed + "원문 바뀜", never auto-applied
//   • unplaced — the quote can't be found → listed in the tray, never misplaced
// "다시 열기" re-anchors every suggestion from its persisted { quote, context } (what a
// reload does): a unique quote re-finds itself, an ambiguous one is disambiguated by
// stored structure, a vanished one drops to unplaced.

import { useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, drawSelection } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { cmPrototypeTheme } from '../cmTheme'
import { anchorLifecycle, liveSugField, setLiveSugs, sugState, reanchor, type Persisted, type SugState } from './anchorLifecycle'

const SAMPLE = `# Release notes

The anchor holds steady as the doc grows around it.

| Concept | Status |
| :-- | :-- |
| anchor | solid |

A sentence that is the target of a unique edit.
`

// The "sidecar" — what survives a reload. (Markdown body stays clean.)
const SEED: Persisted[] = [
  { id: 's1', quote: 'anchor', after: 'anchor point', context: 'table cell' }, // ambiguous → context picks the table cell
  { id: 's2', quote: 'unique edit', after: 'precise edit', context: 'paragraph' }, // unique
  { id: 's3', quote: 'a promise we already removed', after: 'x', context: 'paragraph' }, // missing → unplaced
]

const DOT: Record<SugState, string> = { alive: '#2ecc71', stale: '#e1a100', unplaced: 'var(--muted-foreground)' }
const STATE_KO: Record<SugState, string> = { alive: '살아있음', stale: '낡음', unplaced: '미배치' }

type Row = Persisted & { state: SugState; from?: number; to?: number }

export default function AnchorLifecycleSpike() {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [persisted, setPersisted] = useState<Persisted[]>(SEED)
  const [notFound, setNotFound] = useState<Persisted[]>([])
  const [, bump] = useState(0)

  // Re-anchor everything from the sidecar (what a reload does).
  const doReanchor = (list = persisted) => {
    const view = viewRef.current
    if (!view) return
    const { live, unplaced } = reanchor(view.state, list)
    view.dispatch({ effects: setLiveSugs.of(live) })
    setNotFound(unplaced)
  }

  const apply = (r: Row) => {
    const view = viewRef.current
    if (!view || r.from == null || r.to == null) return
    view.dispatch({ changes: { from: r.from, to: r.to, insert: r.after } })
    view.dispatch({ effects: setLiveSugs.of(view.state.field(liveSugField).filter((s) => s.id !== r.id)) })
    setPersisted((p) => p.filter((s) => s.id !== r.id))
    view.focus()
  }
  const dismiss = (r: Row) => {
    const view = viewRef.current
    if (view) view.dispatch({ effects: setLiveSugs.of(view.state.field(liveSugField).filter((s) => s.id !== r.id)) })
    setPersisted((p) => p.filter((s) => s.id !== r.id))
    setNotFound((u) => u.filter((s) => s.id !== r.id))
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
          anchorLifecycle,
          EditorView.updateListener.of((u) => {
            if (u.docChanged || u.transactions.some((t) => t.effects.length)) bump((n) => n + 1)
          }),
          cmPrototypeTheme,
        ],
      }),
    })
    viewRef.current = view
    doReanchor(SEED) // initial anchoring = the same path as a reload
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Panel rows: anchored ones (state derived live from the doc) + the unplaced tray.
  const view = viewRef.current
  const anchored: Row[] = view
    ? view.state.field(liveSugField).map((s) => ({ ...s, state: sugState(view.state, s) }))
    : []
  const rows: Row[] = [...anchored, ...notFound.map((p) => ({ ...p, state: 'unplaced' as SugState }))]

  const label = { fontSize: 12, color: 'var(--muted-foreground)' }
  const btn = {
    background: 'var(--muted)',
    color: 'var(--foreground)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '2px 8px',
    font: 'inherit',
    fontSize: 12,
    cursor: 'pointer',
  } as const

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--background)', color: 'var(--foreground)' }}>
      <div style={{ padding: '10px 16px', fontSize: 13, color: 'var(--muted-foreground)', borderBottom: '1px solid var(--border)' }}>
        ANCHOR LIFECYCLE — alive / stale / unplaced + reload re-anchoring
      </div>
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div className="cm-prototype" ref={hostRef} style={{ flex: 1, overflow: 'auto', borderRight: '1px solid var(--border)' }} />
        <div style={{ width: 400, padding: 16, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <button type="button" onClick={() => doReanchor()} style={{ ...btn, alignSelf: 'flex-start', padding: '6px 12px' }}>
            🔄 닫았다 다시 열기 (재anchor)
          </button>
          <div style={label}>
            제안의 위치는 저장 안 됨 — 따옴표와 구조로 다시 찾습니다. 본문에서 "unique edit"를 직접 고친 뒤
            다시 열기를 누르면 그 제안이 미배치로 떨어집니다.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {rows.map((r) => (
              <div key={r.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 8, background: DOT[r.state], display: 'inline-block' }} />
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{STATE_KO[r.state]}</span>
                  <span style={{ ...label, marginLeft: 'auto' }}>{r.context}</span>
                </div>
                <div style={{ fontSize: 13 }}>
                  <span style={{ textDecoration: 'line-through', color: 'var(--muted-foreground)' }}>{r.quote}</span>
                  {' → '}
                  <span style={{ color: '#2ecc71' }}>{r.after}</span>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" onClick={() => apply(r)} disabled={r.state !== 'alive'} style={{ ...btn, opacity: r.state === 'alive' ? 1 : 0.4, cursor: r.state === 'alive' ? 'pointer' : 'not-allowed' }}>
                    ✓ Apply
                  </button>
                  <button type="button" onClick={() => dismiss(r)} style={btn}>
                    ✕ Dismiss
                  </button>
                  {r.state === 'stale' && <span style={{ ...label, alignSelf: 'center' }}>원문이 바뀌어 적용 막힘</span>}
                  {r.state === 'unplaced' && <span style={{ ...label, alignSelf: 'center' }}>원문을 못 찾음</span>}
                </div>
              </div>
            ))}
            {rows.length === 0 && <div style={label}>제안 없음</div>}
          </div>
        </div>
      </div>
    </div>
  )
}
