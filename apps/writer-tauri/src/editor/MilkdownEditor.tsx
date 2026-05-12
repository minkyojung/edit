import { useEffect, useRef, useState } from 'react'
import { Editor, rootCtx, editorViewOptionsCtx, editorViewCtx, parserCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import { listItemBlockComponent } from '@milkdown/kit/component/list-item-block'
import { collab, collabServiceCtx } from '@milkdown/plugin-collab'
import { UndoManager } from 'yjs'
import { ySyncPluginKey } from 'y-prosemirror'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { CollabHandle, CollabStatus } from '../hooks/useCollabDoc'
import { createMarkDecoPlugin } from './markDecoPlugin'
import { createMarkCleanupPlugin } from './markCleanupPlugin'
import { createMarkClickPlugin } from './markClickPlugin'
import { createMarkHoverPlugin } from './markHoverPlugin'
import { createDocVersionPlugin } from './docVersionPlugin'
import { createSelectionPlugin, type SelectionInfo } from './selectionPlugin'
import { createFrozenSelectionPlugin } from './frozenSelectionPlugin'
import { formatStatePlugin } from './formatStatePlugin'
import { inlineCodeSafeKeymap } from './inlineCodeSafe'
import { createLinkClickPlugin } from './linkClickPlugin'
import { createLinkHoverPlugin } from './linkHoverPlugin'
import { createSlashTriggerPlugin } from './slashTriggerPlugin'
import { configureListItemBlock } from './listItemConfig'
import { listKeymap } from './listKeymap'
import { headingKeymap } from './headingKeymap'
import { createWikilinkClickPlugin } from './wikilinkClickPlugin'
import {
  createWikilinkPalettePlugin,
  type WikilinkPaletteInfo,
  type WikilinkPaletteKey,
} from './wikilinkPalettePlugin'
import {
  createWikilinkBrokenPlugin,
  wikilinkBrokenKey,
} from './wikilinkBrokenPlugin'
import { createPlaceholderPlugin } from './placeholderPlugin'
import { useDocsStore } from '@/state/docsStore'
import { WikilinkPalette } from './WikilinkPalette'
import { useWikilinkTitleSync } from './wikilinkSyncPlugin'
import { normalizeTitleStructure } from '@/lib/docTitle'
import { useDocLabel } from '../hooks/useDocLabel'
import { MarkToolbar } from './MarkToolbar'
import { LinkHoverBar } from './LinkHoverBar'
import { SlashMenu } from './SlashMenu'
import { proofMarkPlugins } from './proofMarkSchemas'
import { titleGuardPlugin } from './titleGuardPlugin'
import { dailyGuardPlugin } from './dailyGuardPlugin'
import { useEditorViewStore } from '@/state/editorViewStore'
import { EditorFooter } from '@/components/EditorFooter'

interface Props {
  handle: CollabHandle | null
  status: CollabStatus
  onMarkdownChange?: (md: string) => void
  onViewReady?: (view: EditorView | null) => void
}

export function MilkdownEditor({ handle, status, onMarkdownChange, onViewReady }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Editor | null>(null)
  const onChangeRef = useRef(onMarkdownChange)
  onChangeRef.current = onMarkdownChange

  const [selection, setSelection] = useState<SelectionInfo | null>(null)
  // Local view state — EditorFooter (and the UnlinkedNotes trigger
  // nested inside it) needs to walk the PM doc for wikilink
  // references and writing stats, so it needs the live view. The
  // parent App also gets a view via onViewReady; that's separate and
  // kept for its own purposes (e.g. mark popovers).
  const [pmView, setPmView] = useState<EditorView | null>(null)
  // Daily entries: the date is the title, derived from meta.date
  // (mirrored on knownDocs). Renders as a readonly label above the
  // editor. Writing/wiki entries: the title lives as the body's first
  // h1, no separate input — the title is just the editor's first line,
  // covered by the same undo / collab / proof-sdk pattern as the rest
  // of the doc.
  const knownDoc = useDocsStore((s) =>
    handle ? s.knownDocs.find((d) => d.slug === handle.slug) : undefined,
  )
  const isDaily = knownDoc?.type === 'daily'
  const dailyLabel = useDocLabel(handle?.slug ?? null)

  // Live-rewrite wikilinks in this body whenever the referenced
  // child's title changes, so anchor text never drifts from the
  // truth.
  useWikilinkTitleSync(pmView, handle?.slug ?? null)

  // Refresh broken-wikilink decorations whenever the docs registry
  // changes — adding or removing a doc moves the boundary between
  // valid and broken links. The plugin handles docChanged on its
  // own; this effect covers everything else.
  useEffect(() => {
    if (!pmView) return
    const unsubscribe = useDocsStore.subscribe((state, prev) => {
      if (state.knownDocs === prev.knownDocs) return
      pmView.dispatch(pmView.state.tr.setMeta(wikilinkBrokenKey, 'rebuild'))
    })
    return unsubscribe
  }, [pmView])

  // Normalize the doc's title structure on first sync. Single entry
  // point covering both kinds of doc:
  //   - non-daily: dedup leading h1s, ensure first child is an h1
  //     (empty if no title yet), clear stale Y.Text
  //   - daily:     strip the legacy "# YYYY-MM-DD" heading some old
  //                builds seeded into the body, clear stale Y.Text
  // Idempotent via meta.titleNormalizedV2 — see lib/docTitle.ts.
  //
  // Gated on BOTH provider.synced AND meta.type being populated:
  // normalize's internal branch (daily vs non-daily) reads meta.type,
  // so firing it before meta is seeded misclassifies daily docs as
  // writing and erroneously inserts an empty h1 at the top. The
  // catalog → meta seed in docsStore.ensureHandle covers the common
  // case; the meta.observe here is a belt-and-suspenders for any
  // path that opens a handle without going through ensureHandle
  // (or for legacy docs whose meta arrives via provider sync rather
  // than the local seed).
  useEffect(() => {
    if (!handle || !pmView) return
    const ydoc = handle.ydoc
    const provider = handle.provider
    const view = pmView
    const metaMap = ydoc.getMap('meta')
    const opts = {
      fallbackTitle: isDaily ? undefined : knownDoc?.title,
      date: isDaily ? knownDoc?.date : undefined,
    }
    let ran = false
    const tryRun = () => {
      if (ran) return
      if (!provider.isSynced) return
      if (!metaMap.get('type')) return
      ran = true
      normalizeTitleStructure(ydoc, view, opts)
    }
    tryRun()
    provider.on('synced', tryRun)
    metaMap.observe(tryRun)
    return () => {
      provider.off('synced', tryRun)
      metaMap.unobserve(tryRun)
    }
  }, [handle, pmView, isDaily, knownDoc?.title, knownDoc?.date])

  // Bridge between the wikilink-palette plugin (lives inside the
  // Milkdown editor instance) and the React palette popup. The
  // plugin emits state via a window-scoped CustomEvent, the React
  // popup listens. The keyHandlerRef goes the other way — React
  // installs a keydown handler the plugin invokes for arrow / enter
  // / escape so the popup can drive its highlight without the
  // editor swallowing the keys.
  const wikilinkKeyHandler = useRef<((key: WikilinkPaletteKey) => boolean) | null>(null)

  useEffect(() => {
    if (!rootRef.current || !handle) return

    let mounted = true
    const { ydoc, provider } = handle

    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, rootRef.current!)
        ctx.set(editorViewOptionsCtx, { attributes: { class: 'milkdown-editor-root' } })
      })
      .config(configureListItemBlock)
      .use(commonmark)
      .use(gfm)
      .use(listItemBlockComponent)
      // Registered after commonmark so our list keymap wins for
      // list_item context: Enter preserves task `checked` and lifts on
      // empty; Backspace at start of empty item lifts AND merges in
      // one keystroke.
      .use(listKeymap)
      // Enter inside a heading splits into [heading | paragraph]
      // instead of [heading | heading], matching Notion / Bear /
      // Obsidian convention. Registered after commonmark for the same
      // priority reason as listKeymap.
      .use(headingKeymap)
      // No `.use(history)` here on purpose. The collab plugin already
      // wires y-prosemirror's yUndoPlugin (UndoManager-backed) and
      // Mod-Z / Mod-Shift-Z keybindings; adding milkdown's PM-only
      // history plugin on top doubled the undo stacks and only the
      // PM half saw mark mutations, which broke "accept → Cmd+Z →
      // re-accept" by leaving Y.Map gone after the undo.
      .use(clipboard)
      .use(collab)
      // Registered after collab so remote (y-prosemirror) transactions
      // already carry the ySyncPluginKey meta by the time our filter
      // inspects them. Daily and writing/wiki docs have inverted
      // structural invariants — daily's date lives outside the editor
      // and its body must NOT lead with an h1; writing/wiki carry
      // their title as the body's first h1. Each invariant gets its
      // own filter plugin, mutually exclusive per editor instance.
      // See editor/titleGuardPlugin.ts and editor/dailyGuardPlugin.ts
      // for the symmetric rationale.
      .use(isDaily ? dailyGuardPlugin : titleGuardPlugin)
      .use(proofMarkPlugins)
      .use(createMarkDecoPlugin(ydoc))
      .use(createMarkCleanupPlugin(ydoc))
      .use(createMarkClickPlugin())
      .use(createMarkHoverPlugin(ydoc))
      .use(createDocVersionPlugin())
      .use(createSelectionPlugin(setSelection))
      .use(createFrozenSelectionPlugin())
      .use(formatStatePlugin)
      .use(inlineCodeSafeKeymap)
      .use(createLinkClickPlugin())
      .use(createLinkHoverPlugin())
      .use(createSlashTriggerPlugin())
      .use(createWikilinkClickPlugin())
      .use(createWikilinkBrokenPlugin())
      .use(
        createPlaceholderPlugin({
          // Daily docs render their title outside the editor (a
          // readonly date label above the body), so the body has no
          // title slot — pass titleText = undefined and the plugin
          // skips that slot. Non-daily docs carry the title as the
          // body's first h1 (post Stage-2 title fold).
          bodyText: isDaily
            ? "What happened today? — type / for commands"
            : "Start writing… — type [[ to link, / for commands",
          titleText: isDaily ? undefined : 'Untitled',
        }),
      )
      .use(
        createWikilinkPalettePlugin({
          onChange: (info: WikilinkPaletteInfo | null) => {
            window.dispatchEvent(
              new CustomEvent('writer:wikilink-palette', { detail: info }),
            )
          },
          onKey: (key: WikilinkPaletteKey) =>
            wikilinkKeyHandler.current?.(key) ?? false,
        }),
      )
      .create()
      .then((editor) => {
        if (!mounted) {
          editor.destroy()
          return
        }
        editorRef.current = editor

        editor.action((ctx) => {
          const collabService = ctx.get(collabServiceCtx)
          // Build a Y.UndoManager that tracks BOTH the prosemirror
          // XmlFragment (the doc itself) AND the marks Y.Map. Wiring
          // both into the same undo stack means accept/reject's
          // mutation on `marks` is reversed atomically with the PM
          // transaction it accompanied — Cmd+Z after accept correctly
          // restores the suggestion (PM mark + Y.Map metadata both
          // come back), so a follow-up re-accept finds the content
          // exactly where it was.
          //
          // trackedOrigins:
          //   ySyncPluginKey  — y-prosemirror's PM-driven Yjs txns
          //   mark-action     — acceptMark / rejectMark wraps (dispatch +
          //                     marksMap mutation, see markActions.ts)
          //   mark-cleanup    — markCleanupPlugin's microtask follow-up
          //                     when the user deletes marked text
          //                     manually. Tracking it means Backspace +
          //                     Cmd+Z restores BOTH the text and the
          //                     Y.Map metadata atomically; without it,
          //                     the text comes back but the mark's
          //                     stored content stays gone — same dual-
          //                     source bug we just closed for accept.
          //                     Yjs's captureTimeout merges the cleanup
          //                     microtask with the original PM delete
          //                     into one undo step, so Cmd+Z is one
          //                     keystroke either way.
          //
          // Anything outside these origins (e.g. server reconciliation
          // updates from Hocuspocus) stays out of the undo stack so a
          // remote write can't be undone into existence.
          const xmlFragment = ydoc.getXmlFragment('prosemirror')
          const marksMap = ydoc.getMap('marks')
          const undoManager = new UndoManager([xmlFragment, marksMap], {
            trackedOrigins: new Set([
              ySyncPluginKey,
              'mark-action',
              'mark-cleanup',
            ]),
            captureTimeout: 500,
          })
          collabService.setOptions({ yUndoOpts: { undoManager } })
          const service = collabService.bindDoc(ydoc)
          if (provider.awareness) service.setAwareness(provider.awareness)
          service.connect()
        })

        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          setPmView(view)
          onViewReady?.(view)
        })

        // Expose the markdown parser so non-React consumers (mark
        // accept, ingest seed) can turn LLM-emitted markdown into
        // real PM nodes instead of plain text. Cleared on unmount
        // alongside the view.
        editor.action((ctx) => {
          const parser = ctx.get(parserCtx)
          useEditorViewStore.getState().setParser(parser)
        })
      })

    return () => {
      mounted = false
      if (editorRef.current) {
        editorRef.current.action((ctx) => {
          ctx.get(collabServiceCtx).disconnect()
        })
        editorRef.current.destroy()
        editorRef.current = null
      }
      setSelection(null)
      setPmView(null)
      onViewReady?.(null)
      useEditorViewStore.getState().setParser(null)
    }
  }, [handle])

  return (
    <div className="relative flex h-full w-full flex-col">
      <div className="flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="mx-auto max-w-2xl px-8 pt-12 pb-12">
          {isDaily ? (
            <div
              aria-label="Daily date"
              className="mb-6 w-full text-3xl font-semibold leading-tight text-foreground"
            >
              {dailyLabel}
            </div>
          ) : null}
          <div ref={rootRef} />
        </div>
      </div>
      <EditorFooter
        view={pmView}
        parentSlug={handle?.slug ?? null}
        status={status}
        provider={handle?.provider ?? null}
      />
      {handle && <MarkToolbar selection={selection} ydoc={handle.ydoc} onDismiss={() => setSelection(null)} />}
      <LinkHoverBar />
      <SlashMenu />
      <WikilinkPalette
        parentSlug={handle?.slug ?? null}
        keyHandlerRef={wikilinkKeyHandler}
      />
    </div>
  )
}

