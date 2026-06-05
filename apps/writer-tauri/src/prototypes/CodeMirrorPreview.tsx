// DEV-only visual spike: a CodeMirror 6 editor rendering our markdown with
// an Obsidian-style Live Preview, to eyeball it against the real Milkdown
// editor. Reachable at #/dev/cm-prototype (App.tsx, DEV-gated + lazy).
// Throwaway quality — see docs/codemirror-migration-poc-plan.md.

import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
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
import { SAMPLE } from './sample'

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

  useEffect(() => {
    const parent = hostRef.current
    if (!parent) return
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: SAMPLE,
        extensions: [
          history(),
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
          livePreview,
          mermaidCards,
          mediaCards,
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
        CodeMirror Live Preview spike — #/dev/cm-prototype (DEV only)
      </div>
      <div className="cm-prototype" ref={hostRef} />
    </div>
  )
}
