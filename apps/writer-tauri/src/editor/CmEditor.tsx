// CmEditor — Stage 1 of the ProseMirror→CodeMirror swap. A production editor shell
// wired to the REAL doc load/save path, mounted behind a DEV flag ALONGSIDE
// MilkdownEditor (which is left untouched). See docs/archive/codemirror-migration-decision.md
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
// Stage 2/3.

import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { CollabHandle } from '@/hooks/useCollabDoc'
import { useDocsStore } from '@/state/docsStore'
import { setBodyMirror } from '@/state/docsStore/docBody'
import { useEditorSelectionStore } from '@/state/editorSelectionStore'
import { useDocStatsStore, computeDocStats } from '@/state/docStatsStore'
import { registerCmEditor, unregisterCmEditor } from '@/state/activeCmEditor'
import { flushDirty } from '@/lib/docFileSync'
import { scrollOffsetForChange } from '@/editor/cmHunks'
import { acceptEffect, rejectEffect, savedBodyOf, isMaterialized } from '@/editor/cmInBufferReview'
import { usePendingChangesStore } from '@/state/pendingChangesStore'
import { useSettingsStore } from '@/state/settingsStore'
import { DocStatsPanel } from '@/editor/DocStatsPanel'
import { refreshTemplateSlashItems } from '@/lib/templates'
import { buildEditorExtensions, externalBody } from '@/editor/buildExtensions'
import { installUndoRouter } from '@/editor/undoRouter'

interface Props {
  handle: CollabHandle | null
}

export function CmEditor({ handle }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const slug = handle?.slug ?? null
  // Body width is fixed at 750px. Alignment is a live setting (Settings → Editor);
  // changing it re-renders the wrapper CSS vars and CM's resize observer re-wraps
  // lines automatically — no editor remount.
  const textAlign = useSettingsStore((s) => s.editorTextAlign)
  const templatesFolder = useSettingsStore((s) => s.templatesFolder)

  // Load the templates folder into the slash menu. Re-runs when the configured
  // folder changes (Settings → Templates folder) so switching it takes effect
  // live, without a restart. Fire-and-forget: a slow/absent folder just leaves
  // the built-in blocks.
  useEffect(() => {
    void refreshTemplateSlashItems()
  }, [templatesFolder])

  useEffect(() => {
    const parent = rootRef.current
    if (!parent || !handle) return
    let view: EditorView | null = null
    let mounted = true

    // Word/char counts are DISPLAY-ONLY. Capture the STATE (a cheap reference) and
    // serialize/count on a short trailing window — so the O(n) `doc.toString()` runs
    // at most ~every 150ms, never per keystroke. (Persistence no longer runs here at
    // all: the flush PULLS the body from the live editor — see registerCmEditor's
    // getBody + docFileSync — so a keystroke only flags the slug dirty.)
    let statsTimer: number | null = null
    let statsState: EditorState | null = null
    const scheduleStats = (state: EditorState) => {
      statsState = state
      if (statsTimer !== null) return
      statsTimer = window.setTimeout(() => {
        statsTimer = null
        if (statsState) useDocStatsStore.getState().setStats(computeDocStats(statsState.doc.toString()))
      }, 150)
    }

    // Cmd-Z / Cmd-Shift-Z router — forwards a document-level undo/redo into the
    // current view (Accept/Reject from the chat panel leaves focus off CM). Reads
    // `view` lazily so it always routes to the live view after a doc switch.
    const removeUndoRouter = installUndoRouter(() => view)

    void handle.contentReady.then(() => {
      if (!mounted || !rootRef.current) return
      view = new EditorView({
        parent: rootRef.current,
        state: EditorState.create({
          doc: handle.bodyMarkdown,
          extensions: buildEditorExtensions({ slug: handle.slug, scheduleStats }),
        }),
      })
      viewRef.current = view // expose for the floating menu
      // Seed the stats panel before the first edit fires a docChanged update.
      useDocStatsStore.getState().setStats(computeDocStats(handle.bodyMarkdown))
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
      registerCmEditor({
        slug: handle.slug,
        setBody: (md, changeId) => {
          const v = view
          if (!v) return
          // If this change is showing as an in-buffer proposal, the in-buffer review
          // OWNS the buffer (its reconcile deletes the red on accept). The legacy
          // whole-doc replace would FIGHT that, so skip it here — do nothing and let
          // the review handle it. (The dual path was what duplicated on undo.)
          if (changeId && isMaterialized(v.state, changeId)) return
          const changes = { from: 0, to: v.state.doc.length, insert: md }
          v.dispatch(
            changeId
              ? { changes, effects: acceptEffect.of(changeId) }
              : { changes, annotations: externalBody.of(true) },
          )
        },
        // Reject bridge: an effect-only, undoable transaction (used by both the inline
        // ✕ and the chat panel via rejectPendingChange).
        rejectChange: (changeId) => view?.dispatch({ effects: rejectEffect.of(changeId) }),
        // Scroll bridge: jump to a change's location (chat suggestion card click).
        scrollToChange: (changeId) => {
          const v = view
          if (!v) return
          const change = usePendingChangesStore.getState().byId[changeId]
          if (!change) return
          const at = scrollOffsetForChange(v.state.doc.toString(), change)
          if (at === null) return
          v.dispatch({ selection: { anchor: Math.min(at, v.state.doc.length) }, scrollIntoView: true })
        },
        // Materialized query: is this change showing as an in-buffer proposal? The
        // applier asks before applying, so it skips changes the review already owns.
        isMaterialized: (changeId) => (view ? isMaterialized(view.state, changeId) : false),
        // Body reader: the flush PULLS the current saved body from here (CM state is
        // the source of truth). Excludes pending-green proposal text (disk only holds
        // accepted content), matching what the old per-keystroke mirror wrote.
        getBody: () => (view ? savedBodyOf(view.state) : ''),
      })
    })

    return () => {
      mounted = false
      // Checkpoint (doc switch AND editor unmount). SYNCHRONOUSLY pull the latest body
      // into the cache BEFORE tearing the view down: the flush now reads from the live
      // editor (getBody), but `flushDirty()` is async and we destroy the view below in
      // the same tick — so without this the leaving doc's last keystrokes would be gone
      // by the time the async flush runs. Writing the cache here (the same value getBody
      // returns) makes the torn-down handle's body current for this flush and any later
      // one. flushDirty then persists it (Obsidian "save on note switch").
      if (view) {
        const h = useDocsStore.getState().handles[handle.slug]
        if (h) setBodyMirror(h, savedBodyOf(view.state))
      }
      void flushDirty()
      if (statsTimer !== null) window.clearTimeout(statsTimer)
      removeUndoRouter()
      if (handle) unregisterCmEditor(handle.slug)
      useEditorSelectionStore.getState().setSelection(null)
      useEditorSelectionStore.getState().setCollapse(null)
      useDocStatsStore.getState().setStats(null)
      view?.destroy()
      view = null
      viewRef.current = null
    }
    // Re-runs only on slug change (a doc switch); mount-time deps are stable.
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
        data-header-fade
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
      {/* CM owns the scroll (.cm-scroller, overflow:auto) and fills the remaining
          height (flex-1 + min-h-0 so it can shrink and scroll internally). The
          alignment/hyphen vars are read by layoutReset's .cm-content rule, so set
          them here on the scroller's ancestor. Left-align uses 'manual' so words
          don't auto-hyphenate (ragged right). */}
      <div
        className="cm-prototype min-h-0 flex-1"
        ref={rootRef}
        style={{
          '--cm-text-align': textAlign,
          '--cm-hyphens': textAlign === 'justify' ? 'auto' : 'manual',
        } as React.CSSProperties}
      />
      <DocStatsPanel />
    </div>
  )
}
