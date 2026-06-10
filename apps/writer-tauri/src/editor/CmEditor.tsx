// CmEditor — Stage 1 of the ProseMirror→CodeMirror swap. A production editor shell
// wired to the REAL doc load/save path, mounted behind a DEV flag ALONGSIDE
// MilkdownEditor (which is left untouched). See docs/codemirror-migration-decision.md
// §9 / §11.5.
//
// Scope (Stage 1, intentionally minimal & reversible):
//   • load:  handle.bodyMarkdown → CM doc (after contentReady)
//   • save:  on every change → markSlugDirty(slug) + handle.bodyMarkdown = doc text.
//            The 500ms flush loop is already editor-agnostic (serializeDocToFiles
//            reads handle.bodyMarkdown), so nothing else is needed for persistence.
//   • render: the verified prototype stack (live-preview + blocks + arrow nav).
// NOT in Stage 1: proof/AI marks, slash menu, wikilink palette, link/footer chrome,
// external live-reload into CM (reloadFromVault only dispatches into a PM view) — all
// Stage 2/3. onViewReady is called with null because PM-view consumers can't use a CM
// view; they degrade rather than break.

import { useEffect, useRef } from 'react'
import type { EditorView as PMEditorView } from '@milkdown/kit/prose/view'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap, drawSelection, dropCursor } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { indentUnit } from '@codemirror/language'
import { markdown, insertNewlineContinueMarkup, deleteMarkupBackward } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import type { CollabHandle, CollabStatus } from '@/hooks/useCollabDoc'
import { useDocsStore } from '@/state/docsStore'
import { markSlugDirty } from '@/lib/docFileSync'
import { cmPrototypeTheme } from '@/prototypes/cmTheme'
import { livePreviewV2, taskCheckboxClick } from '@/prototypes/v2/livePreview'
import { blocksV2 } from '@/prototypes/v2/blocks'
import { tableArrowEntry } from '@/prototypes/v2/editableTable'
import { blockVerticalNav } from '@/prototypes/v2/blockVerticalNav'

interface Props {
  handle: CollabHandle | null
  status: CollabStatus
  onViewReady?: (view: PMEditorView | null) => void
  header?: React.ReactNode
}

// The page layout (header/footer overlays + max-w-2xl column) is owned by this
// component's wrapper, so neutralise cmPrototypeTheme's own page padding / max-width.
const layoutReset = EditorView.theme({
  '.cm-content': { maxWidth: 'none', margin: '0', padding: '0' },
})

export function CmEditor({ handle, status, onViewReady, header }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const slug = handle?.slug ?? null

  useEffect(() => {
    const parent = rootRef.current
    if (!parent || !handle) return
    let view: EditorView | null = null
    let mounted = true

    void handle.contentReady.then(() => {
      if (!mounted || !rootRef.current) return
      view = new EditorView({
        parent: rootRef.current,
        state: EditorState.create({
          doc: handle.bodyMarkdown,
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
            livePreviewV2,
            blocksV2,
            tableArrowEntry,
            blockVerticalNav,
            // Save: mirror the doc text into the handle cache + flag dirty. The flush
            // loop (serializeDocToFiles → handle.bodyMarkdown) does the rest.
            EditorView.updateListener.of((u) => {
              if (!u.docChanged) return
              const h = useDocsStore.getState().handles[handle.slug]
              if (h) h.bodyMarkdown = u.state.doc.toString()
              markSlugDirty(handle.slug)
            }),
            Prec.lowest(cmPrototypeTheme),
            layoutReset,
          ],
        }),
      })
      onViewReady?.(null) // no PM view — PM-view consumers degrade, not break
    })

    return () => {
      mounted = false
      view?.destroy()
      view = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug])

  return (
    <div className="relative flex h-full w-full flex-col">
      <div className="flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div
          className="mx-auto max-w-2xl px-8"
          style={{ paddingTop: 'calc(var(--header-h) + 1.5rem)', paddingBottom: 'calc(var(--footer-h) + 3rem)' }}
        >
          {header}
          <div className="cm-prototype" ref={rootRef} />
        </div>
      </div>
      {status === 'error' && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded bg-destructive px-3 py-1 text-sm text-white">
          문서를 불러오지 못했습니다
        </div>
      )}
    </div>
  )
}
