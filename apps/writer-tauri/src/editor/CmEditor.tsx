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
import { EditorState, Prec, Annotation } from '@codemirror/state'
import { EditorView, keymap, drawSelection, dropCursor, placeholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands'
import { indentUnit } from '@codemirror/language'
import { markdown, deleteMarkupBackward } from '@codemirror/lang-markdown'
import { autocompletion } from '@codemirror/autocomplete'
import { GFM } from '@lezer/markdown'
import type { CollabHandle, CollabStatus } from '@/hooks/useCollabDoc'
import { useDocsStore } from '@/state/docsStore'
import { useEditorSelectionStore } from '@/state/editorSelectionStore'
import { registerCmEditor, unregisterCmEditor } from '@/state/activeCmEditor'
import { markSlugDirty } from '@/lib/docFileSync'
import { cmPrototypeTheme } from '@/prototypes/cmTheme'
import { livePreviewV2, taskCheckboxClick, wikilinkKnown } from '@/prototypes/v2/livePreview'
import { blocksV2 } from '@/prototypes/v2/blocks'
import { tableArrowEntry } from '@/prototypes/v2/editableTable'
import { blockVerticalNav } from '@/prototypes/v2/blockVerticalNav'
import { inlineFormatKeymapNoLink } from '@/prototypes/v2/inlineFormat'
import { wikilinkClick } from '@/prototypes/wikilinkNav'
import { linkClick } from '@/prototypes/linkNav'
import { timestampSeekClick } from '@/editor/cmTimestampSeek'
import { youtubeCards } from '@/prototypes/youtubeCards'
import { mermaidCards } from '@/prototypes/mermaidCards'
import { navigateToNoteByTitle, isKnownNoteTitle } from '@/editor/cmNav'
import { cmProofReview, acceptEffect, rejectEffect, scrollOffsetForChange } from '@/editor/cmProofReview'
import { usePendingChangesStore } from '@/state/pendingChangesStore'
import {
  highlightRenderExtension,
  highlightSelectionNotifier,
  highlightClickExtension,
  highlightHotkey,
  highlightsSyncEffect,
} from '@/editor/cmHighlights'
import { CmHighlightBar } from '@/editor/CmHighlightBar'
import { openLinkSafely } from '@/editor/linkUtils'
import { cmWikilinkSource } from '@/editor/cmAutocomplete'
import { slashSource } from '@/prototypes/slashCommands'
import { smartEnter } from '@/prototypes/listEnter'
import { imeListContinue } from '@/prototypes/imeListContinue'
import { mediaDropPaste } from '@/prototypes/mediaDrop'
import { importMediaToVault } from '@/editor/cmMedia'

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

// `status` is still accepted (callers pass it) but no longer rendered —
// the connection-state readout lived in the now-removed footer.
export function CmEditor({ handle, onViewReady, header }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const slug = handle?.slug ?? null

  useEffect(() => {
    const parent = rootRef.current
    if (!parent || !handle) return
    let view: EditorView | null = null
    let mounted = true

    // Cmd-Z / Cmd-Shift-Z router. Accept/Reject from the CHAT PANEL lands an undoable
    // entry in THIS editor's history, but the click leaves focus on the chat button, so
    // a plain Cmd-Z never reaches CM. We catch it at the document level and forward to
    // this view's undo/redo — UNLESS focus is in a text-entry element (the editor's own
    // contenteditable, the chat composer, any input), which owns its undo. That guard
    // also prevents a double-undo when the editor itself is focused (CM's keymap runs).
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      const el = document.activeElement as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      const v = view
      if (!v) return
      const did = e.shiftKey ? redo(v) : undo(v)
      if (did) e.preventDefault()
    }
    document.addEventListener('keydown', onKeyDown)

    void handle.contentReady.then(() => {
      if (!mounted || !rootRef.current) return
      view = new EditorView({
        parent: rootRef.current,
        state: EditorState.create({
          doc: handle.bodyMarkdown,
          extensions: [
            history(),
            // Safari/WKWebView drops the Enter that confirms an IME composition, so a
            // Korean list item + Enter wouldn't continue the list. Recover it from the
            // browser's own beforeinput (insertParagraph/insertLineBreak) signal.
            imeListContinue(),
            indentUnit.of('  '),
            // ENTER — one deterministic handler at Prec.highest: tight list continuation
            // / clean exit, blockquote continuation, else plain newline. Must beat every
            // other Enter handler so CM's loose-list inference never runs.
            Prec.highest(keymap.of([{ key: 'Enter', run: smartEnter }])),
            // ⌘B/⌘I/⌘E/⌘⇧X wrap toggles (Prec.high → beats defaultKeymap). ⌘K
            // (link) is intentionally omitted: it opens the command palette.
            inlineFormatKeymapNoLink,
            keymap.of([
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
            youtubeCards, // a bare youtube URL line → inline player
            mermaidCards, // ```mermaid fence → live diagram (portable across md apps)
            highlightRenderExtension(handle.slug), // paint recorded highlights
            highlightSelectionNotifier, // selection → "Highlight" prompt in the bar
            // Mirror the live selection into the editor-agnostic store so the
            // chat panel can show the selection chip + inject it as context.
            // We publish the line range too (CM knows it cheaply) so the chip
            // can read "Note · L10–14" rather than a raw text snippet.
            EditorView.updateListener.of((u) => {
              if (!u.selectionSet && !u.docChanged) return
              const m = u.state.selection.main
              const store = useEditorSelectionStore.getState()
              if (m.empty) {
                store.setSelection(null)
                return
              }
              store.setSelection({
                text: u.state.sliceDoc(m.from, m.to),
                fromLine: u.state.doc.lineAt(m.from).number,
                toLine: u.state.doc.lineAt(m.to).number,
              })
            }),
            highlightClickExtension, // click a highlight → open it for a note
            highlightHotkey(handle.slug), // ⌘⇧M → highlight the selection

            tableArrowEntry,
            blockVerticalNav,
            wikilinkKnown.of(isKnownNoteTitle), // blue vs red from REAL knownDocs
            wikilinkClick(navigateToNoteByTitle), // click [[Title]] → open that note
            timestampSeekClick, // plain-click a YouTube timestamp → seek the embed
            linkClick(openLinkSafely), // Cmd/Ctrl-click [text](url) → open (safe schemes)
            mediaDropPaste(importMediaToVault), // drop/paste media → vault + insert
            cmProofReview(handle.slug), // AI suggestions from pendingChangesStore → inline marks
            // Save: mirror the doc text into the handle cache + flag dirty. The flush
            // loop (serializeDocToFiles → handle.bodyMarkdown) does the rest. A
            // programmatic body set (externalBody) is a load from disk — don't dirty
            // it.
            EditorView.updateListener.of((u) => {
              if (!u.docChanged) return
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
      viewRef.current = view // expose for the highlight sync + floating menu
      onViewReady?.(null) // no PM view — PM-view consumers degrade, not break
      // Let the chat's selection-chip X collapse this view's selection
      // without the chat holding an editor reference.
      useEditorSelectionStore.getState().setCollapse(() => {
        const v = view
        if (!v) return
        const head = v.state.selection.main.head
        v.dispatch({ selection: { anchor: head, head } })
      })
      // Register so docsStore body-replace paths can push fresh markdown into this
      // view. An ACCEPT (changeId present) is dispatched as an UNDOABLE transaction
      // tagged with acceptEffect, so Cmd-Z reverts the doc AND reopens the change
      // (cmProofReview's invertedEffects). External reload / seed (no changeId) stays
      // non-undoable and carries externalBody so the dirty tracker ignores it.
      registerCmEditor(
        handle.slug,
        (md, changeId) => {
          const v = view
          if (!v) return
          const changes = { from: 0, to: v.state.doc.length, insert: md }
          v.dispatch(
            changeId
              ? { changes, effects: acceptEffect.of(changeId) }
              : { changes, annotations: externalBody.of(true) },
          )
        },
        // Reject bridge: an effect-only, undoable transaction (used by both the inline
        // ✕ and the chat panel via rejectPendingChange).
        (changeId) => view?.dispatch({ effects: rejectEffect.of(changeId) }),
        // Scroll bridge: jump to a change's location (chat suggestion card click).
        (changeId) => {
          const v = view
          if (!v) return
          const change = usePendingChangesStore.getState().byId[changeId]
          if (!change) return
          const at = scrollOffsetForChange(v.state.doc.toString(), change)
          if (at === null) return
          v.dispatch({ selection: { anchor: Math.min(at, v.state.doc.length) }, scrollIntoView: true })
        },
      )
    })

    return () => {
      mounted = false
      document.removeEventListener('keydown', onKeyDown)
      if (handle) unregisterCmEditor(handle.slug)
      useEditorSelectionStore.getState().setSelection(null)
      useEditorSelectionStore.getState().setCollapse(null)
      view?.destroy()
      view = null
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug])

  // Repaint highlights when this doc's highlight records change (create /
  // remove / note edit). The render extension seeds the initial set at
  // mount; this keeps it in sync afterwards.
  useEffect(() => {
    if (!slug) return
    return useDocsStore.subscribe((s, prev) => {
      const cur = s.knownDocs.find((d) => d.slug === slug)?.highlights
      const old = prev.knownDocs.find((d) => d.slug === slug)?.highlights
      if (cur !== old) viewRef.current?.dispatch({ effects: highlightsSyncEffect(slug) })
    })
  }, [slug])

  return (
    <div className="relative flex h-full w-full flex-col">
      {/* Header gradient-blur glass band. A sibling of the scroll
          content (not inside EditorHeader) so backdrop-filter can
          sample the scrolled pixels. An explicit z-index is REQUIRED:
          CM6's `.cm-editor` is `position: relative`, so as a z-auto
          positioned element later in the DOM it paints OVER a z-auto
          band — the 90% bg never even shows (text stays crisp). z-[5]
          lifts the band into its own layer above CM, while staying
          below the header chrome (EditorHeader, z-sticky = 10) so the
          tabs/buttons keep painting on top. */}
      <div
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 right-0 z-[5] bg-background/90"
        style={{
          height: 'calc(var(--header-h) + 2rem)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          maskImage:
            'linear-gradient(to bottom, black 0, black calc(var(--header-h) * 0.7), transparent)',
          WebkitMaskImage:
            'linear-gradient(to bottom, black 0, black calc(var(--header-h) * 0.7), transparent)',
        }}
      />
      <div className="flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div
          className="mx-auto max-w-2xl px-8"
          style={{ paddingTop: 'calc(var(--header-h) + 1.5rem)', paddingBottom: '4rem' }}
        >
          {header}
          <div className="cm-prototype" ref={rootRef} />
        </div>
      </div>
      <CmHighlightBar viewRef={viewRef} slug={slug} />
    </div>
  )
}
