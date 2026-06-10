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

import { useEffect, useRef, useState } from 'react'
import type { EditorView as PMEditorView } from '@milkdown/kit/prose/view'
import { EditorState, Prec, Annotation } from '@codemirror/state'
import { EditorView, keymap, drawSelection, dropCursor, placeholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { indentUnit } from '@codemirror/language'
import { markdown, insertNewlineContinueMarkup, deleteMarkupBackward } from '@codemirror/lang-markdown'
import { autocompletion } from '@codemirror/autocomplete'
import { GFM } from '@lezer/markdown'
import type { CollabHandle, CollabStatus } from '@/hooks/useCollabDoc'
import { useDocsStore } from '@/state/docsStore'
import { registerCmEditor, unregisterCmEditor } from '@/state/activeCmEditor'
import { markSlugDirty } from '@/lib/docFileSync'
import { EditorFooter } from '@/components/EditorFooter'
import type { DocStats } from '@/stores/editorFooter'
import { cmPrototypeTheme } from '@/prototypes/cmTheme'
import { livePreviewV2, taskCheckboxClick, wikilinkKnown } from '@/prototypes/v2/livePreview'
import { blocksV2 } from '@/prototypes/v2/blocks'
import { tableArrowEntry } from '@/prototypes/v2/editableTable'
import { blockVerticalNav } from '@/prototypes/v2/blockVerticalNav'
import { wikilinkClick } from '@/prototypes/wikilinkNav'
import { navigateToNoteByTitle, isKnownNoteTitle } from '@/editor/cmNav'
import { cmWikilinkSource } from '@/editor/cmAutocomplete'
import { slashSource } from '@/prototypes/slashCommands'

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

// Tags a programmatic whole-body replace (external reload / background rewrite) so the
// dirty-tracking update listener ignores it — it's a load FROM disk, not a user edit.
const externalBody = Annotation.define<boolean>()

// Word/char count from the raw markdown. (Counts include markdown syntax chars —
// good enough for a status-bar number; AI% needs proof marks, a Stage-3 concern.)
const computeCmStats = (text: string): DocStats => ({
  totalChars: text.length,
  aiChars: 0,
  wordCount: text.split(/\s+/).filter(Boolean).length,
  lastAcceptedAt: null,
})

export function CmEditor({ handle, status, onViewReady, header }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const slug = handle?.slug ?? null
  const [stats, setStats] = useState<DocStats>(() => computeCmStats(''))

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
            autocompletion({ override: [cmWikilinkSource, slashSource], icons: true }), // [[ notes, / blocks
            placeholder('Start writing…'),
            taskCheckboxClick,
            livePreviewV2,
            blocksV2,
            tableArrowEntry,
            blockVerticalNav,
            wikilinkKnown.of(isKnownNoteTitle), // blue vs red from REAL knownDocs
            wikilinkClick(navigateToNoteByTitle), // click [[Title]] → open that note
            // Save: mirror the doc text into the handle cache + flag dirty. The flush
            // loop (serializeDocToFiles → handle.bodyMarkdown) does the rest. A
            // programmatic body set (externalBody) is a load from disk — don't dirty
            // it, but DO refresh the footer stats either way.
            EditorView.updateListener.of((u) => {
              if (!u.docChanged) return
              setStats(computeCmStats(u.state.doc.toString()))
              if (u.transactions.some((t) => t.annotation(externalBody))) return
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
      setStats(computeCmStats(handle.bodyMarkdown))
      // Register so docsStore body-replace paths (external reload / background
      // rewrite) can push fresh markdown into this view instead of skipping it.
      registerCmEditor(handle.slug, (md) => {
        const v = view
        if (!v) return
        v.dispatch({
          changes: { from: 0, to: v.state.doc.length, insert: md },
          annotations: externalBody.of(true),
        })
      })
    })

    return () => {
      mounted = false
      if (handle) unregisterCmEditor(handle.slug)
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
      <div className="absolute bottom-0 left-0 right-0 z-sticky" style={{ height: 'var(--footer-h)' }}>
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-0 left-0 right-0 bg-background/90"
          style={{
            height: 'calc(var(--footer-h) + 2rem)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            maskImage: 'linear-gradient(to top, black 0, black calc(var(--footer-h) * 0.7), transparent)',
            WebkitMaskImage: 'linear-gradient(to top, black 0, black calc(var(--footer-h) * 0.7), transparent)',
          }}
        />
        <EditorFooter view={null} parentSlug={slug} status={status} externalStats={stats} />
      </div>
    </div>
  )
}
