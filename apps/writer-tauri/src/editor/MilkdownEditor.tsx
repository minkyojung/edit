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
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { CollabHandle, CollabStatus } from '../hooks/useCollabDoc'
import { createDirtyTrackerPlugin } from './dirtyTrackerPlugin'
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
  type PendingEditAnchor,
} from './aiEditGutterPlugin'
import { createPlaceholderPlugin } from './placeholderPlugin'
import { useDocsStore } from '@/state/docsStore'
import { useGitStore, isAiEditCommit } from '@/state/gitStore'
import { usePendingEditsStore } from '@/state/pendingEditsStore'
import { getActiveVaultPath } from '@/state/settingsStore'
import { pathForDoc } from '@/lib/docPaths'
import { WikilinkPalette } from './WikilinkPalette'
import { useWikilinkTitleSync } from './wikilinkSyncPlugin'
import { normalizeDailyBody } from '@/lib/docTitle'
import { LinkHoverBar } from './LinkHoverBar'
import { SelectionBubble } from './SelectionBubble'
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
    // Pending edits live in their own store; the gutter plugin pulls
    // them via `getPendingEdits`. Mirror the git refresh path so a
    // freshly-arrived `chat/edit-pending` (or an Apply/Reject that
    // clears one) repaints the gutter in the same tick.
    const unsubPending = usePendingEditsStore.subscribe((state, prev) => {
      if (state.byId === prev.byId) return
      refresh()
    })
    return () => {
      unsubGit()
      unsubDocs()
      unsubPending()
    }
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
          getPendingEdits: () => collectPendingAnchors(),
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

        // All post-create setup runs in one ctx acquisition. After the
        // Yjs-removal migration the editor stores its working copy in
        // PM (not Y.Doc), so the bind-collab / build-UndoManager dance
        // is gone. What remains is a one-shot hydrate: copy whatever
        // applyVaultBodyToYDoc seeded into the Y.Doc fragment over into
        // the PM doc via `yXmlFragmentToProseMirrorRootNode`, marked
        // non-undoable so Cmd-Z doesn't strip the hydrate.
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx)

          const xmlFragment = ydoc.getXmlFragment('prosemirror')
          if (xmlFragment.length > 0) {
            try {
              const root = yXmlFragmentToProseMirrorRootNode(
                xmlFragment,
                view.state.schema,
              )
              view.dispatch(
                view.state.tr
                  .replaceWith(0, view.state.doc.content.size, root.content)
                  .setMeta('addToHistory', false),
              )
            } catch (err) {
              console.warn(
                '[MilkdownEditor] Y.Doc → PM hydrate failed',
                handle.slug,
                err,
              )
            }
          }
          // Brand-new docs with an empty fragment fall through: PM's
          // schema-required minimal fill (one empty paragraph,
          // installed by Milkdown's defaultValueCtx '') is what the
          // user sees, and they start typing into a clean slate.

          // Parser / serializer come from the headless Milkdown built
          // at app boot (lib/headlessMilkdown.ts) — populated globally
          // in editorViewStore before any doc opens. Per-doc editor
          // instances no longer publish them, removing the race that
          // left vault load waiting on parser-not-set.
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
      if (editorRef.current) {
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
      {/* Mask gradient creates a soft fade-out where scrolled lines meet
          the EditorHeader: top of the scroll container (the header's
          y-range) is masked transparent, with a 1rem fade-in band just
          below. Content scrolls up under the opaque header and is
          smoothly erased at the seam rather than abruptly clipped. */}
      <div
        className="flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{
          maskImage:
            'linear-gradient(to bottom, transparent 0, transparent var(--header-h), black calc(var(--header-h) + 1.5rem))',
          WebkitMaskImage:
            'linear-gradient(to bottom, transparent 0, transparent var(--header-h), black calc(var(--header-h) + 1.5rem))',
        }}
      >
        {/* pt accounts for the EditorHeader overlay (var(--header-h))
            plus the original 3rem of breathing room before PageHeader. */}
        <div className="mx-auto max-w-2xl px-8 pb-12" style={{ paddingTop: 'calc(var(--header-h) + 1.5rem)' }}>
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
      <SelectionBubble />
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
function collectPendingAnchors(): PendingEditAnchor[] {
  const byId = usePendingEditsStore.getState().byId
  const anchors: PendingEditAnchor[] = []
  const vault = getActiveVaultPath()
  for (const edit of Object.values(byId)) {
    if (edit.status !== 'pending') continue
    if (edit.toolName !== 'Edit') continue
    const oldString = typeof edit.input.old_string === 'string'
      ? edit.input.old_string
      : ''
    if (!oldString) continue
    const filePath = typeof edit.input.file_path === 'string'
      ? edit.input.file_path
      : ''
    if (!filePath) continue
    anchors.push({
      pendingId: edit.id,
      toolName: edit.toolName,
      relPath: toVaultRelative(filePath, vault),
      oldString,
    })
  }
  return anchors
}

/** Strip the active vault root off an absolute file_path. Falls back
 * to recognised top-level folders so paths resolved through symlinks
 * still match. Mirrors PendingEditsBar's heuristic — kept inline
 * here instead of extracting a util because both sites use it once
 * and the variants don't share enough to make a util worthwhile. */
function toVaultRelative(filePath: string, vault: string | null): string {
  if (!filePath) return ''
  if (vault) {
    const root = vault.endsWith('/') ? vault : vault + '/'
    if (filePath.startsWith(root)) return filePath.slice(root.length)
  }
  for (const dir of ['daily/', 'wiki/', 'writing/', '_system/']) {
    const idx = filePath.indexOf('/' + dir)
    if (idx !== -1) return filePath.slice(idx + 1)
  }
  return filePath
}

