// DEV-only visual spike: a CodeMirror 6 editor rendering our markdown with
// an Obsidian-style Live Preview, to eyeball it against the real Milkdown
// editor. Reachable at #/dev/cm-prototype (App.tsx, DEV-gated + lazy).
// Throwaway quality — see docs/codemirror-migration-poc-plan.md.

import { useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, drawSelection, dropCursor, placeholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { autocompletion } from '@codemirror/autocomplete'
import { indentUnit } from '@codemirror/language'
import { markdown, insertNewlineContinueMarkup, deleteMarkupBackward } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { cmPrototypeTheme } from './cmTheme'
import { livePreview } from './livePreview'
import { mermaidCards } from './mermaidCards'
import { mediaCards } from './mediaCards'
import { slashSource } from './slashCommands'
import { wikilinkSource } from './wikilinkComplete'
import { wikilinkClick } from './wikilinkNav'
import { linkClick } from './linkNav'
import { formatKeymap } from './formatCommands'
import { highlights, highlightClick } from './highlights'
import { mediaDropPaste } from './mediaDrop'
import { imeComposition } from './imeComposition'
import { imeListContinue } from './imeListContinue'
import { initialStatus, bumpRevision, markSaved, onDocChange, type DocStatus } from './saveStatus'
import { SAMPLE } from './sample'
import { useDocsStore } from '@/state/docsStore'
import { getActiveVaultPath } from '@/state/settingsStore'
import { markSlugDirty, flushDirty } from '@/lib/docFileSync'

// E-step: a single dedicated sandbox note this prototype reads/writes — it
// NEVER touches real user notes. ONLY runs when the user explicitly opts in via
// the "Connect vault" button (never on mount), so merely opening this dev route
// makes ZERO vault writes. Get-or-create under today's daily, return its slug +
// current markdown. null when no vault.
const SANDBOX_TITLE = '⟨CM Prototype Sandbox⟩'

async function getSandboxDoc(): Promise<{ slug: string; markdown: string } | null> {
  if (!getActiveVaultPath()) return null
  const store = useDocsStore.getState()
  // Match only a writing-type doc so a same-titled daily/wiki/article can't be
  // resolved (and overwritten) by accident.
  let slug = store.knownDocs.find((d) => d.type === 'writing' && d.title === SANDBOX_TITLE)?.slug ?? null
  if (!slug) {
    const daily = await store.openDaily()
    if (!daily) return null
    slug = await store.createWritingChild(daily, SANDBOX_TITLE)
    if (!slug) return null
  }
  await store.ensureHandle(slug)
  const handle = useDocsStore.getState().handles[slug]
  if (!handle) return null
  await handle.contentReady
  return { slug, markdown: handle.bodyMarkdown }
}

// Stand-in for an article's .meta.json highlight records.
const SAMPLE_HIGHLIGHTS = [
  { id: 'hl1', quote: 'comfortable reading measure', occurrence: 0, note: 'nice phrasing' },
  { id: 'hl2', quote: 'reveal themselves', occurrence: 0 },
]

// Prototype stand-in for "navigate to note" — a transient toast. The real app
// would route to the doc here.
function toast(message: string): void {
  const el = document.createElement('div')
  el.textContent = message
  el.style.cssText =
    'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
    'background:var(--foreground);color:var(--background);padding:8px 14px;' +
    'border-radius:8px;font-size:13px;z-index:9999;opacity:0.95;'
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 1500)
}

export default function CodeMirrorPreview() {
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<DocStatus>(initialStatus)
  const [source, setSource] = useState<string>('in-memory (SAMPLE)')
  // Opt-in: stays false on mount, so opening this dev route makes ZERO vault
  // writes. The "Connect vault" button flips it to run the real sandbox
  // round-trip (and rebuild the view via the effect dep).
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const parent = hostRef.current
    if (!parent) return
    let saveTimer: number | undefined
    let view: EditorView | null = null
    let cancelled = false

    void (async () => {
      // Default: in-memory SAMPLE, NO vault side effects. Only when the user has
      // opted in (`connected`) do we touch the dedicated sandbox note.
      const sandbox = connected ? await getSandboxDoc() : null
      if (cancelled) return
      const slug = sandbox?.slug ?? null
      let initial = sandbox?.markdown ?? ''
      if (slug && initial.trim() === '') {
        // First connect: seed SAMPLE into the (empty) sandbox so the demo is
        // rich AND persisted. Guard with `cancelled` so a torn-down mount can't
        // still write.
        initial = SAMPLE
        const h = useDocsStore.getState().handles[slug]
        if (h && !cancelled) {
          h.bodyMarkdown = SAMPLE
          markSlugDirty(slug)
          void flushDirty()
        }
      } else if (!slug) {
        initial = SAMPLE
      }
      setSource(slug ? `vault: ${slug}` : 'in-memory (SAMPLE) — not saved')

      // On edit: the CM doc IS the markdown. In-memory mode (no slug) just bumps
      // the revision; connected mode writes straight to the sandbox handle +
      // debounced flush. No serializer. Only ever the sandbox.
      const save = (v: EditorView) => {
        setStatus(bumpRevision)
        if (!slug) return // in-memory: nothing to persist
        const h = useDocsStore.getState().handles[slug]
        if (h) {
          h.bodyMarkdown = v.state.doc.toString()
          markSlugDirty(slug)
        }
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = window.setTimeout(() => {
          void flushDirty().then(() => {
            if (!cancelled) setStatus(markSaved)
          })
        }, 800)
      }

      view = new EditorView({
        parent,
        state: EditorState.create({
          doc: initial,
          extensions: [
            history(),
            imeComposition, // track composition; decoration fields freeze while composing
            // Safari/WKWebView drops the composition-confirming Enter, so the
            // markdown list/quote continuation never runs. Recover it from the
            // browser's own insertParagraph/insertLineBreak beforeinput signal
            // (language-agnostic — see imeListContinue.ts).
            imeListContinue(),
            // CM draws its OWN caret (a DOM .cm-cursor) instead of the native
            // one — the native caret renders as a horizontal bar next to our
            // replace/atomic decorations during IME composition (the Korean
            // "가로 커서" artifact). Obsidian/basicSetup use this for the same reason.
            drawSelection(),
            dropCursor(), // caret indicator showing where a drag will drop
            formatKeymap, // Cmd+B/I/E/Shift+X format toggles, Cmd+K link
            indentUnit.of('  '), // 2-space list nesting
            // Editing behavior (#1): markdown markup commands take precedence
            // over the generic defaults, then Tab indent, then the rest.
            keymap.of([
              { key: 'Enter', run: insertNewlineContinueMarkup },
              { key: 'Backspace', run: deleteMarkupBackward },
              indentWithTab,
              ...defaultKeymap,
              ...historyKeymap,
            ]),
            EditorView.lineWrapping,
            markdown({ extensions: [GFM], addKeymap: false }),
            // One autocomplete config, two sources (each returns null when not
            // applicable): `/` slash menu + `[[` wikilink palette.
            autocompletion({ override: [slashSource, wikilinkSource], icons: true }),
            wikilinkClick((title) => toast(`→ open note: ${title}`)),
            linkClick((url) => toast(`→ open URL: ${url}`)),
            highlights(SAMPLE_HIGHLIGHTS),
            highlightClick((_id, note) => toast(note ? `📝 ${note}` : 'highlight')),
            // Prototype stub: object-URL instead of a real vault copy, so dropped
            // images/video actually render.
            mediaDropPaste((file) => Promise.resolve(URL.createObjectURL(file))),
            placeholder('Start writing…'),
            // Save real edits to the sandbox note (debounced flush to disk).
            onDocChange(save),
            livePreview,
            mermaidCards,
            mediaCards,
            cmPrototypeTheme,
          ],
        }),
      })
    })()

    return () => {
      cancelled = true
      if (saveTimer) clearTimeout(saveTimer)
      view?.destroy()
    }
  }, [connected])

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
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <span>CM Live Preview — {source}</span>
        <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {!connected && (
            <button
              type="button"
              onClick={() => setConnected(true)}
              style={{
                font: 'inherit',
                color: 'var(--info)',
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '2px 8px',
                cursor: 'pointer',
              }}
              title="Round-trips through the dedicated sandbox note only. Off by default so opening this route never writes to the vault."
            >
              Connect vault (save test)
            </button>
          )}
          <span style={{ color: status.dirty ? 'var(--info)' : 'var(--muted-foreground)' }}>
            {status.dirty ? '● unsaved' : '✓ saved'} · rev {status.rev}
          </span>
        </span>
      </div>
      <div className="cm-prototype" ref={hostRef} />
    </div>
  )
}
