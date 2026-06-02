import { useEffect, useRef, useState } from 'react'
import {
  Editor,
  rootCtx,
  editorViewOptionsCtx,
  editorViewCtx,
  defaultValueCtx,
  parserCtx,
  serializerCtx,
} from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import { listItemBlockComponent } from '@milkdown/kit/component/list-item-block'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { CollabHandle, CollabStatus } from '../hooks/useCollabDoc'
import { createDirtyTrackerPlugin } from './dirtyTrackerPlugin'
import { createInlineReviewPlugin } from './inlineReviewPlugin'
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
import { history } from '@milkdown/kit/plugin/history'
import {
  createAiEditGutterPlugin,
  aiEditGutterKey,
} from './aiEditGutterPlugin'
import { createPlaceholderPlugin } from './placeholderPlugin'
import { useDocsStore } from '@/state/docsStore'
import { useEditorViewStore } from '@/state/editorViewStore'
import { useGitStore, isAiEditCommit } from '@/state/gitStore'
import { pathForDoc } from '@/lib/docPaths'
import { flushDirty } from '@/lib/docFileSync'
import { applyMarkdownToEditor } from '@/lib/seedMarkdown'
import {
  resolveWikilinksInMarkdown,
  condenseWikilinksInMarkdown,
} from '@/lib/wikilinkResolve'
import { WikilinkPalette } from './WikilinkPalette'
import { useWikilinkTitleSync } from './wikilinkSyncPlugin'
import { useHighlightMarks } from './useHighlightMarks'
import { normalizeDailyBody } from '@/lib/docTitle'
import { LinkHoverBar } from './LinkHoverBar'
import { SelectionMenu } from './SelectionMenu'
import { createHighlightClickPlugin } from './highlightClickPlugin'
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

  // Paint saved-article highlights (records → proofHighlight marks),
  // re-anchored on mount and whenever the record set changes.
  useHighlightMarks(pmView, handle?.slug ?? null)

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

  // Drive the AI-edit gutter from gitStore. Two responsibilities:
  //   1. Make sure every active ai-edit commit's detail is in cache
  //      (the gutter plugin can't draw a marker without diff line
  //      numbers). Prefetched once per sha; ensureCommitDetail
  //      de-dupes concurrent calls.
  //   2. Send a `rebuild` meta whenever the inputs the plugin reads
  //      from gitStore change (activity list, commitDetails cache,
  //      dismissedShas). docChanged transactions rebuild on their
  //      own — this covers the "git pushed new data" channel.
  useEffect(() => {
    if (!pmView) return
    function refresh() {
      const view = pmView
      if (!view) return
      const store = useGitStore.getState()
      for (const c of store.activity) {
        if (!isAiEditCommit(c)) continue
        if (store.dismissedShas.has(c.sha)) continue
        if (store.commitDetails[c.sha]) continue
        if (store.loadingShas.has(c.sha)) continue
        void store.ensureCommitDetail(c.sha)
      }
      view.dispatch(view.state.tr.setMeta(aiEditGutterKey, 'rebuild'))
    }
    refresh()
    const unsubGit = useGitStore.subscribe((state, prev) => {
      if (
        state.activity === prev.activity &&
        state.commitDetails === prev.commitDetails &&
        state.dismissedShas === prev.dismissedShas
      ) {
        return
      }
      refresh()
    })
    const unsubDocs = useDocsStore.subscribe((state, prev) => {
      // Title / archive changes can shift the active file path, which
      // changes which commits the plugin should match.
      if (state.knownDocs === prev.knownDocs) return
      refresh()
    })
    // Phase F: pending-edit gutter markers retired. The chat-edit
    // flow now stages proposals in `pendingChangesStore` and renders
    // them via the inline review widget on the page, which carries
    // the diff + Keep/Reject inline. A separate gutter bar would be
    // duplicate signal for the same change. Committed-side markers
    // (`unsubGit`) stay — those still surface "where the AI just
    // committed" once the inline widget resolves.
    return () => {
      unsubGit()
      unsubDocs()
    }
  }, [pmView])

  // Daily-doc body normalization: strip the legacy "# YYYY-MM-DD"
  // heading that older builds seeded into the body markdown. Daily
  // docs render their date label outside the editor, so the body
  // must not duplicate it. Idempotent — `cleanupDailyDateHeading`
  // bails at the first non-matching block, so a clean body costs
  // one node-type check on each mount. Non-daily docs run no
  // normalization.
  //
  // Gated on contentReady so the legacy headings landed in PM
  // before we look for them. The catalog (`knownDoc.type` / `.date`)
  // is the source of truth for whether this is a daily, replacing
  // the Y.Map gate that Phase 5c retired.
  useEffect(() => {
    if (!handle || !pmView) return
    if (!isDaily) return
    if (!knownDoc?.date) return
    const view = pmView
    const opts = { date: knownDoc.date }
    let cancelled = false
    void handle.contentReady.then(() => {
      if (cancelled) return
      normalizeDailyBody(view, opts)
    })
    return () => {
      cancelled = true
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

    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, rootRef.current!)
        ctx.set(editorViewOptionsCtx, { attributes: { class: 'milkdown-editor-root' } })
        // Explicit empty default. Phase 5a of the Yjs-removal
        // migration seeds the real body via a PM dispatch inside the
        // post-create `.then` instead of through `defaultValueCtx`,
        // because the markdown isn't loaded until `contentReady`
        // resolves and `defaultValueCtx` is consumed synchronously.
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
      // PM history owns Cmd-Z / Cmd-Shift-Z after the Yjs-removal
      // migration. The `history` bundle from @milkdown/kit ships five
      // pieces — config, provider plugin, keymap, undoCommand,
      // redoCommand — all required together. Registering only the
      // keymap (without the commands it dispatches to) leaves Cmd-Z
      // captured but unhandled, which manifests as "Cmd-Z silently
      // does nothing". The y-prosemirror yUndoPlugin (set up by the
      // now-removed collab plugin) used to claim the chord; with
      // collab gone, this bundle is the only handler. Behaviour is
      // closer to user intent now, since the PM stack tracks only
      // local transactions (external edits hydrated via
      // `reloadFromVault` dispatch with `addToHistory: false`, so
      // they don't pollute Cmd-Z).
      .use(history)
      .use(clipboard)
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
      .use(createDocVersionPlugin())
      // Flush-trigger: marks this slug dirty whenever PM's doc
      // changes, so the auto-flush tick picks it up and writes the
      // freshest markdown to disk. Replaces the Y.Doc fragment
      // observer that the collab plugin used to power — see
      // ./dirtyTrackerPlugin.ts for the migration context.
      .use(createDirtyTrackerPlugin(handle.slug))
      // Subscribes to pendingChangesStore and surfaces this doc's
      // staged AI changes as PM decorations. C1 stage: infra only
      // (returns empty DecorationSet). C2 populates the inline diff
      // styling, C3 adds the Accept / Reject widget buttons.
      .use(createInlineReviewPlugin(handle.slug))
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
      .use(createHighlightClickPlugin())
      .use(createWikilinkBrokenPlugin())
      // AI-edit gutter — coloured bar to the left of any block touched
      // by an unreviewed ai-edit commit in the active doc. Pure
      // visualisation of git activity; state lives in gitStore and is
      // pushed into the plugin via `rebuild` meta from the subscribe
      // effect below. See aiEditGutterPlugin.ts.
      .use(
        createAiEditGutterPlugin({
          getActiveRelPath: () => {
            if (!handle) return null
            const docs = useDocsStore.getState().knownDocs
            const doc = docs.find((d) => d.slug === handle.slug)
            if (!doc) return null
            return pathForDoc(doc, (s) => docs.find((d) => d.slug === s))
          },
          getActiveShas: () => {
            const { activity, dismissedShas } = useGitStore.getState()
            const out: string[] = []
            for (const c of activity) {
              if (!isAiEditCommit(c)) continue
              if (dismissedShas.has(c.sha)) continue
              out.push(c.sha)
            }
            return out
          },
          getCommitDetail: (sha) => useGitStore.getState().commitDetails[sha],
        }),
      )
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

        // Wait for the body to land on the handle before painting it
        // into PM. contentReady resolves once both the Y.Doc fragment
        // (legacy path) AND `handle.bodyMarkdown` (Phase 5a) are
        // populated by `buildHandle`.
        await handle.contentReady
        if (!mounted) return

        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx)

          // Publish the LIVE editor's parser + serializer to the
          // app-wide store. This is the single source of markdown
          // conversion — same schema instance the EditorView itself
          // uses, so `applyMarkdownToEditor` can dispatch the parsed
          // node directly without a JSON round-trip. The previous
          // arrangement (a headless ghost Milkdown owning parser /
          // serializer for the app lifetime) created TWO PM schemas
          // that drifted apart on `list_item.spread` and broke any
          // reload that fed a bullet-list page back into PM. One
          // editor, one schema — no drift possible.
          //
          // Phase L1: wrap both with wikilink form translators so PM
          // sees `[Title](note:slug)` (which it already understands
          // as a link mark) while disk + bodyMarkdown carry the
          // canonical `[[Title]]` shape. The wrappers preserve
          // identity on input that doesn't contain wikilinks (the
          // regex is no-op for plain markdown) so unrelated content
          // is untouched.
          const rawParser = ctx.get(parserCtx)
          const rawSerializer = ctx.get(serializerCtx)
          const parser = (md: string) =>
            rawParser(resolveWikilinksInMarkdown(md))
          const serializer = (doc: Parameters<typeof rawSerializer>[0]) =>
            condenseWikilinksInMarkdown(rawSerializer(doc))
          useEditorViewStore.getState().setParser(parser)
          useEditorViewStore.getState().setSerializer(serializer)

          // Mount-time hydrate. Reads `handle.bodyMarkdown` only —
          // the cache populated by `buildHandle` / `reloadFromVault`
          // / `seedDocBody` / `replaceDocBody`. Brand-new docs
          // (empty bodyMarkdown) fall through to Milkdown's
          // schema-fill (one empty paragraph). `applyMarkdownToEditor`
          // centralises the noise-line strip (`<br />`) and the
          // `addToHistory: false` meta so the mount hydrate and the
          // reloadFromVault dispatch share one path.
          applyMarkdownToEditor(view, handle.bodyMarkdown, parser)

          setPmView(view)
          onViewReady?.(view)

          // Drain any pending mark-scroll target so the queue doesn't
          // grow indefinitely. The actual scroll-to-mark capability
          // went away with the mark plugins (Phase 3.B); the chat
          // panel no longer enqueues new entries, but the drain stays
          // here as a guardrail.
          usePendingScroll.getState().drain(handle.slug)
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
      // Phase I: poke the flush before tearing the editor down. The
      // in-memory mirror (`handle.bodyMarkdown`) is already current
      // because dirtyTrackerPlugin updates it per-transaction, so
      // even if this `flushDirty` runs asynchronously after the
      // unmount returns it still finds the latest content via the
      // handle (no PM needed). Fire-and-forget on purpose — React
      // cleanup can't be async, and a failed write retries on the
      // next interval tick anyway.
      void flushDirty()
      if (editorRef.current) {
        editorRef.current.destroy()
        editorRef.current = null
      }
      setPmView(null)
      onViewReady?.(null)
      // Clear parser / serializer on unmount. The next MilkdownEditor
      // mount publishes a fresh pair from its own ctx. Any reader
      // that lands in the gap (very narrow — between editor destroy
      // and the next mount's post-create `.then`) sees `null` and
      // skips the dispatch; that's the same gate every consumer
      // already has (`if (view && parser)`).
      useEditorViewStore.getState().setParser(null)
      useEditorViewStore.getState().setSerializer(null)
    }
  }, [handle])

  return (
    <div className="relative flex h-full w-full flex-col">
      {/* Header gradient-blur glass band — mirrors EditorFooter's
          pattern. Lives here (a sibling of the scroll content) rather
          than inside EditorHeader so backdrop-filter can sample the
          scroll content's pixels — WebKit can't sample across the
          scroll container's composited layer boundary. The actual
          header chrome (tabs/buttons) still renders in AppShell with
          z-sticky and paints on top of this band. */}
      <div
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 right-0 bg-background/90"
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
        {/* pt accounts for the EditorHeader overlay (var(--header-h)).
            pb leaves room for the EditorFooter overlay (var(--footer-h))
            plus the 1.5rem fade band so the last paragraph isn't already
            inside the dissolve when scrolled to bottom. */}
        <div
          className="mx-auto max-w-2xl px-8"
          style={{
            paddingTop: 'calc(var(--header-h) + 1.5rem)',
            paddingBottom: 'calc(var(--footer-h) + 3rem)',
          }}
        >
          {header}
          <div ref={rootRef} />
        </div>
      </div>
      {/* Footer is a gradient-blur glass band: top edge transparent
          (no blur), bottom fully blurred. The mask isolates the
          backdrop-filter to a faded layer so text reads cleanly on
          top while content scrolling below feathers out. */}
      <div
        className="absolute bottom-0 left-0 right-0 z-sticky"
        style={{ height: 'var(--footer-h)' }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-0 left-0 right-0 bg-background/90"
          style={{
            height: 'calc(var(--footer-h) + 2rem)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            maskImage:
              'linear-gradient(to top, black 0, black calc(var(--footer-h) * 0.7), transparent)',
            WebkitMaskImage:
              'linear-gradient(to top, black 0, black calc(var(--footer-h) * 0.7), transparent)',
          }}
        />
        <EditorFooter
          view={pmView}
          parentSlug={handle?.slug ?? null}
          status={status}
        />
      </div>
      <LinkHoverBar />
      <SelectionMenu />
      <SlashMenu />
      <WikilinkPalette
        parentSlug={handle?.slug ?? null}
        keyHandlerRef={wikilinkKeyHandler}
      />
    </div>
  )
}

/** Snapshot of every still-pending Edit-shaped staged edit, normalised
 * into the anchor shape the gutter plugin consumes. The gutter only
 * needs the vault-relative path + the old_string anchor; it filters
 * out anything pointing at a different doc internally.
 *
 * We strip the vault prefix here (instead of inside the plugin) so
 * the plugin stays oblivious to vault layout — same pattern as the
 * chat panel's preview card. `Write` / `MultiEdit` / `NotebookEdit`
 * are skipped: their inputs don't carry an `old_string` anchor we
 * can map to a single block, and the chat panel card already
 * surfaces them. */

/** Strip the active vault root off an absolute file_path. Falls back
 * to recognised top-level folders so paths resolved through symlinks
 * still match. Mirrors PendingEditsBar's heuristic — kept inline
 * here instead of extracting a util because both sites use it once
 * and the variants don't share enough to make a util worthwhile. */

