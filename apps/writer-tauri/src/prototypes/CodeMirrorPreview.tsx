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
import { SAMPLE } from './sample'

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
