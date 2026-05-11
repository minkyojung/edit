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
import { UnlinkedNotes } from './UnlinkedNotes'
import { useWikilinkTitleSync } from './wikilinkSyncPlugin'
import { migrateTitleToFirstH1 } from '@/lib/docTitle'
import { useDocLabel } from '../hooks/useDocLabel'
import { MarkToolbar } from './MarkToolbar'
import { LinkHoverBar } from './LinkHoverBar'
import { SlashMenu } from './SlashMenu'
import { proofMarkPlugins } from './proofMarkSchemas'
import { useEditorViewStore } from '@/state/editorViewStore'

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
  // Local view state — UnlinkedNotes needs to walk the PM doc for
  // wikilink references, so it needs the live view. The parent App
  // also gets a view via onViewReady; that's separate and kept for
  // its own purposes (e.g. mark popovers).
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

  // One-time migration for daily entries created before the
  // date-as-meta rework. Older builds seeded "# YYYY-MM-DD" into the
  // body via proofClient.createDoc's default markdown, sometimes
  // multiple times under racing bootstraps. Now that the date lives
  // only in meta, those leading H1 nodes are pure duplication. After
  // the first sync (so we see the canonical body) we walk the doc,
  // remove any H1 at the very top whose plain text is the daily's
  // date or a concatenation of it ("2026-05-042026-05-04"), and
  // stamp meta.titleCleanedV1 so we never re-run.
  useEffect(() => {
    if (!pmView || !handle || !isDaily || !knownDoc?.date) return
    const ydoc = handle.ydoc
    const provider = handle.provider
    const date = knownDoc.date
    let ran = false
    const run = () => {
      if (ran) return
      ran = true
      const meta = ydoc.getMap('meta')
      if (meta.get('titleCleanedV1')) return
      cleanupDailyBodyDateHeading(pmView, date)
      ydoc.transact(() => {
        meta.set('titleCleanedV1', true)
      })
    }
    if (provider.isSynced) run()
    else provider.on('synced', run)
    return () => {
      provider.off('synced', run)
    }
  }, [pmView, handle, isDaily, knownDoc?.date])

  // Fold the legacy Y.Text('title') into the editor body as a level-1
  // heading at the top. Runs once per doc (gated by meta.titleMigratedToH1)
  // on first sync. After this, every consumer reads the title from the
  // h1 — same code path as every other piece of editable content, so
  // undo / collab / proof-sdk patterns cover it for free.
  //
  // Daily entries are skipped inside migrateTitleToFirstH1 — their
  // title is rendered from meta.date outside the body.
  //
  // Title source priority: existing h1 > Y.Text('title') > catalog
  // title from knownDocs (mirrors proofClient.createDoc's server
  // metadata, used for freshly-created docs that never seeded
  // Y.Text). Replaces the older Y.Text seed effect: once h1 is the
  // source of truth, re-seeding Y.Text on every open is a ghost
  // write the read path ignores.
  useEffect(() => {
    if (!handle || !pmView || isDaily) return
    const ydoc = handle.ydoc
    const provider = handle.provider
    const view = pmView
    const fallback = knownDoc?.title
    let ran = false
    const run = () => {
      if (ran) return
      ran = true
      migrateTitleToFirstH1(ydoc, view, fallback)
    }
    if (provider.isSynced) run()
    else provider.on('synced', run)
    return () => {
      provider.off('synced', run)
    }
  }, [handle, pmView, isDaily, knownDoc?.title])

  // Bridge between the wikilink-palette plugin (lives inside the
  // Milkdown editor instance) and the React palette popup. The
  // plugin emits state via a window-scoped CustomEvent, the React
  // popup listens. The keyHandlerRef goes the other way — React
  // installs a keydown handler the plugin invokes for arrow / enter
  // / escape so the popup can drive its highlight without the
  // editor swallowing the keys.
  const wikilinkKeyHandler = useRef<((key: WikilinkPaletteKey) => boolean) | null>(null)
  // Status is consumed by AppSidebar's header now — keep the prop in
  // the public surface (callers still pass it) but suppress the lint
  // for the deliberately-unused symbol.
  void status

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
      .use(proofMarkPlugins)
      .use(createMarkDecoPlugin(ydoc))
      .use(createMarkCleanupPlugin(ydoc))
      .use(createMarkClickPlugin())
      .use(createMarkHoverPlugin())
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
          text: isDaily
            ? "What happened today? — type / for commands"
            : "Start writing… — type [[ to link, / for commands",
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
    <div className="relative h-full w-full">
      <div className="h-full w-full overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
          <UnlinkedNotes view={pmView} parentSlug={handle?.slug ?? null} />
        </div>
      </div>
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

/** Strip leading H1 nodes whose plain text is the daily's date or a
 * concatenation of repeats of it (legacy artifact). Stops at the
 * first non-matching block so we never delete a heading the user
 * intentionally wrote. Date format is the same YYYY-MM-DD that
 * meta.date stores; we tolerate any whole-number repeat
 * ("2026-05-04", "2026-05-042026-05-04", …) so duplications from
 * pre-fix multi-bootstrap races also get cleaned up. */
function cleanupDailyBodyDateHeading(view: EditorView, date: string): void {
  const doc = view.state.doc
  let pos = 0
  let endRemovePos = 0
  for (let i = 0; i < doc.childCount; i += 1) {
    const child = doc.child(i)
    if (child.type.name !== 'heading') break
    if (child.attrs.level !== 1) break
    if (!isRepeatedDate(child.textContent, date)) break
    endRemovePos = pos + child.nodeSize
    pos += child.nodeSize
  }
  if (endRemovePos === 0) return
  const tr = view.state.tr.delete(0, endRemovePos)
  tr.setMeta('addToHistory', false)
  view.dispatch(tr)
}

function isRepeatedDate(text: string, date: string): boolean {
  if (text.length === 0 || date.length === 0) return false
  if (text.length % date.length !== 0) return false
  const repeats = text.length / date.length
  for (let i = 0; i < repeats; i += 1) {
    if (text.slice(i * date.length, (i + 1) * date.length) !== date) return false
  }
  return true
}
