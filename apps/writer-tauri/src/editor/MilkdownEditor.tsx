import { useEffect, useRef, useState } from 'react'
import {
  Editor,
  rootCtx,
  editorViewOptionsCtx,
  editorViewCtx,
  defaultValueCtx,
} from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import { listItemBlockComponent } from '@milkdown/kit/component/list-item-block'
import { collab, collabServiceCtx } from '@milkdown/plugin-collab'
import * as Y from 'yjs'
import { UndoManager } from 'yjs'
import { prosemirrorToYDoc, ySyncPluginKey } from 'y-prosemirror'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { CollabHandle, CollabStatus } from '../hooks/useCollabDoc'
import { createMarkDecoPlugin } from './markDecoPlugin'
import { createMarkCleanupPlugin } from './markCleanupPlugin'
import { createMarkClickPlugin } from './markClickPlugin'
import { createMarkHoverPlugin } from './markHoverPlugin'
import { createDocVersionPlugin } from './docVersionPlugin'
import { createFrozenSelectionPlugin } from './frozenSelectionPlugin'
import { formatStatePlugin } from './formatStatePlugin'
import { dropCursor } from '@milkdown/kit/prose/dropcursor'
import { $prose } from '@milkdown/kit/utils'
import { cardDropAdvanceCursor } from './cardDropAdvanceCursor'
import { audioNodeView } from './cards/AudioCardNodeView'
import { imageNodeView } from './cards/ImageCardNodeView'
import { videoNodeView } from './cards/VideoCardNodeView'
import { imageInlineNodeView } from './imageInlineNodeView'
import { mediaDropPastePlugin } from './mediaDropPastePlugin'
import { inlineCodeSafeKeymap } from './inlineCodeSafe'
import { createLinkClickPlugin } from './linkClickPlugin'
import { createLinkHoverPlugin } from './linkHoverPlugin'
import { createPasteSanitizerPlugin } from './pasteSanitizerPlugin'
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
import { normalizeDailyBody } from '@/lib/docTitle'
import { LinkHoverBar } from './LinkHoverBar'
import { SlashMenu } from './SlashMenu'
// Proof schemas come from proof-sdk via a thin adapter so client and
// server share one canonical definition. The previous local copy
// drifted out of sync; restoring the canonical schemas closed the
// projection-repair crash class. The bundle covers three plugins:
//   - proofMarkPlugins        — 7 mark types (proofSuggestion / etc.)
//   - codeBlockExtPlugins     — redefines `code_block` to allow
//                                 proof marks inside (without this
//                                 our code_block node shape diverges
//                                 from the server's)
//   - frontmatterSchema       — block-level YAML frontmatter node
//                                 (we don't emit one, but registering
//                                 keeps the two schemas symmetric)
// See ./proofMarks.ts for adapter notes.
import { proofSchemaPlugins } from './proofMarks'
import { dailyGuardPlugin } from './dailyGuardPlugin'
import { usePendingScroll } from '@/state/pendingScrollStore'
import { scrollToMark } from '@/editor/scrollToMark'
import { EditorFooter } from '@/components/EditorFooter'
import { notify } from '@/lib/notify'

interface Props {
  handle: CollabHandle | null
  status: CollabStatus
  onMarkdownChange?: (md: string) => void
  onViewReady?: (view: EditorView | null) => void
  /** Slot rendered above the body, inside the same scrollable
   * column. Owned by the parent (typically <Page>) so doc-kind
   * branching for the title surface lives outside the editor.
   * The editor itself is now agnostic to whether this is a daily
   * date label, a system page name, or an editable wiki title. */
  header?: React.ReactNode
}

export function MilkdownEditor({ handle, status, onMarkdownChange, onViewReady, header }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Editor | null>(null)
  const onChangeRef = useRef(onMarkdownChange)
  onChangeRef.current = onMarkdownChange

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

  // Daily-doc body normalization: strip the legacy "# YYYY-MM-DD"
  // heading that older builds seeded into the body markdown. Daily
  // docs render their date label outside the editor, so the body
  // must not duplicate it. Idempotent via meta.titleNormalizedV2 —
  // see lib/docTitle.ts. Non-daily docs run no normalization.
  //
  // Gated on contentReady AND meta.type being populated. The title
  // structure lives in the Y.Doc that vault load (or fresh creation)
  // populated; normalization runs after both signals are in.
  useEffect(() => {
    if (!handle || !pmView) return
    if (!isDaily) return
    const { ydoc, contentReady } = handle
    const view = pmView
    const metaMap = ydoc.getMap('meta')
    const opts = { date: knownDoc?.date }
    let ran = false
    let hydrated = false
    const tryRun = () => {
      if (ran) return
      if (!hydrated) return
      if (!metaMap.get('type')) return
      ran = true
      normalizeDailyBody(ydoc, view, opts)
    }
    void contentReady.then(() => {
      hydrated = true
      tryRun()
    })
    metaMap.observe(tryRun)
    return () => {
      metaMap.unobserve(tryRun)
    }
  }, [handle, pmView, isDaily, knownDoc?.date])

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
    const { ydoc } = handle

    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, rootRef.current!)
        ctx.set(editorViewOptionsCtx, { attributes: { class: 'milkdown-editor-root' } })
        // Explicit empty default so the editor's pre-collab doc state is
        // documented rather than implicit. Collab's bindDoc replaces this
        // once handle.contentReady resolves; the ctx exists to keep the
        // pre-bind window deterministic if Milkdown's internal default
        // ever changes between versions.
        ctx.set(defaultValueCtx, '')
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
      // Daily docs: filter out leading h1s so the body never grows a
      // date heading that duplicates the external date label. Non-daily
      // docs have no structural body invariant — whatever the user
      // writes is content, and the displayed label is derived from the
      // first non-empty block (see lib/docLabel.ts). Registered after
      // collab so remote (y-prosemirror) transactions already carry
      // the ySyncPluginKey meta by the time our filter inspects them.
      .use(isDaily ? [dailyGuardPlugin] : [])
      // proofSchemaPlugins == proofMarks + codeBlockExt + frontmatter
      // (see ./proofMarks.ts). Registration order mirrors
      // proof-sdk/server/milkdown-headless.ts:150-158 so marks are
      // available before code_block_ext references them in its `marks: '...'`
      // content spec.
      .use(proofSchemaPlugins)
      .use(createMarkDecoPlugin(ydoc))
      .use(createMarkCleanupPlugin(ydoc))
      .use(createMarkClickPlugin())
      .use(createMarkHoverPlugin(ydoc))
      .use(createDocVersionPlugin())
      .use(createFrozenSelectionPlugin())
      .use(formatStatePlugin)
      .use(inlineCodeSafeKeymap)
      .use(imageNodeView)
      .use(videoNodeView)
      .use(audioNodeView)
      .use(imageInlineNodeView)
      .use(cardDropAdvanceCursor)
      .use($prose(() => dropCursor({ color: false, width: 2, class: 'pm-drop-cursor' })))
      .use(mediaDropPastePlugin)
      .use(createPasteSanitizerPlugin())
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
      .then(async (editor) => {
        if (!mounted) {
          editor.destroy()
          return
        }
        editorRef.current = editor

        // Wait for IndexedDB to finish hydrating the ydoc before binding
        // the collab service. y-prosemirror's sync plugin runs an initial
        // PM↔Y reconcile the moment it sees a ydoc; if we bind while the
        // fragment is empty (pre-hydrate) and content fills in after,
        // PM ends up with a doc where the hydrated paragraphs sit
        // alongside new client items the initial reconcile created — the
        // 1→2→4→8 doubling regression. Binding after contentReady means
        // PM sees the fully-populated fragment from frame one and the
        // initial reconcile is a no-op. contentReady spans IDB hydrate
        // AND vault load (Path C) so binding waits for vault-sourced
        // body + marks to land, not just the in-browser cache.
        await handle.contentReady
        if (!mounted) return

        // All post-create setup runs in one ctx acquisition: seed an
        // empty fragment, bind collab + UndoManager, expose the view to
        // React, drain any scroll-to-mark request that arrived before
        // this slug's editor mounted. The ordering here is meaningful —
        // seed MUST precede bindDoc, and bindDoc must precede setPmView
        // so React subscribers always see a fully-wired view.
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx)

          // If hydration left the fragment empty (brand-new note),
          // pre-seed it with the schema's minimal fill (one empty
          // paragraph) before binding. y-prosemirror's sync plugin
          // compares PM's filled doc against the fragment on first bind;
          // an empty fragment vs PM's schema-required <paragraph/>
          // triggers a PM→Y commit that puts an extra paragraph node
          // into the fragment for good. After the user types into PM's
          // paragraph, the fragment ends up with two paragraph items —
          // the leading empty one is the visible regression. Seeding the
          // same shape PM would have filled means the diff check is a
          // no-op and no spurious commit fires.
          const xmlFragment = ydoc.getXmlFragment('prosemirror')
          if (xmlFragment.length === 0) {
            const fill = view.state.schema.topNodeType.createAndFill()
            if (fill) {
              const seedDoc = prosemirrorToYDoc(fill, 'prosemirror')
              const update = Y.encodeStateAsUpdate(seedDoc)
              Y.applyUpdate(ydoc, update, 'doc-init')
              seedDoc.destroy()
            }
          }

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
          // Anything outside these origins stays out of the undo stack
          // so a programmatic write can't be undone into existence.
          const collabService = ctx.get(collabServiceCtx)
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
          // No awareness (multi-cursor / presence) since Phase 3.C
          // removed the WebSocket provider — local-only editor.
          collabService.bindDoc(ydoc).connect()

          // Parser / serializer come from the headless Milkdown built
          // at app boot (lib/headlessMilkdown.ts) — populated globally
          // in editorViewStore before any doc opens. Per-doc editor
          // instances no longer publish them, removing the race that
          // left vault load waiting on parser-not-set.
          setPmView(view)
          onViewReady?.(view)

          // Drain a pending "scroll to this mark" target queued by the
          // chat panel before this slug's editor was mounted. rAF defers
          // one paint so decoration plugins finish their first build
          // pass and the target mark has stable coords.
          const pendingMarkId = usePendingScroll.getState().drain(handle.slug)
          if (pendingMarkId) {
            requestAnimationFrame(() => scrollToMark(view, pendingMarkId))
          }
        })
      })
      .catch((err) => {
        // Editor.make().create() or the post-create setup rejected.
        // Without this catch the chain failed silently and the user saw
        // an empty editor with no signal that anything went wrong, which
        // makes the bug class invisible in production. Unmount races land
        // here too, so skip the toast when the component has already
        // torn down.
        if (!mounted) return
        console.error('[MilkdownEditor] editor create failed', err)
        notify.editorInitFailed()
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
      setPmView(null)
      onViewReady?.(null)
      // Parser / serializer are owned by the headless Milkdown
      // (lib/headlessMilkdown.ts) for the app's lifetime — don't
      // null them on per-doc unmount.
    }
  }, [handle])

  return (
    <div className="relative flex h-full w-full flex-col">
      <div className="flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="mx-auto max-w-2xl px-8 pt-12 pb-12">
          {header}
          <div ref={rootRef} />
        </div>
      </div>
      <EditorFooter
        view={pmView}
        parentSlug={handle?.slug ?? null}
        status={status}
      />
      <LinkHoverBar />
      <SlashMenu />
      <WikilinkPalette
        parentSlug={handle?.slug ?? null}
        keyHandlerRef={wikilinkKeyHandler}
      />
    </div>
  )
}

