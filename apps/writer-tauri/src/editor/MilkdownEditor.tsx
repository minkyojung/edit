import { useEffect, useRef, useState } from 'react'
import { Editor, rootCtx, editorViewOptionsCtx, editorViewCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import { collab, collabServiceCtx } from '@milkdown/plugin-collab'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { CollabHandle, CollabStatus } from '../hooks/useCollabDoc'
import { createMarkDecoPlugin } from './markDecoPlugin'
import { createMarkCleanupPlugin } from './markCleanupPlugin'
import { createMarkClickPlugin } from './markClickPlugin'
import { createDocVersionPlugin } from './docVersionPlugin'
import { createSelectionPlugin, type SelectionInfo } from './selectionPlugin'
import { createFrozenSelectionPlugin } from './frozenSelectionPlugin'
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
import { useDocTitle } from '../hooks/useDocTitle'
import { useDocLabel } from '../hooks/useDocLabel'
import { MarkToolbar } from './MarkToolbar'
import { proofMarkPlugins } from './proofMarkSchemas'

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
  const { title, setTitle } = useDocTitle(handle?.ydoc ?? null)
  // Daily entries: the date is the title, derived from meta.date
  // (mirrored on knownDocs). Title field becomes a readonly label.
  // Writing entries: title is user content, editable.
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
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(clipboard)
      .use(collab)
      .use(proofMarkPlugins)
      .use(createMarkDecoPlugin())
      .use(createMarkCleanupPlugin(ydoc))
      .use(createMarkClickPlugin())
      .use(createDocVersionPlugin())
      .use(createSelectionPlugin(setSelection))
      .use(createFrozenSelectionPlugin())
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
          const service = collabService.bindDoc(ydoc)
          if (provider.awareness) service.setAwareness(provider.awareness)
          service.connect()
        })

        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          setPmView(view)
          onViewReady?.(view)
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
          ) : (
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Untitled"
              aria-label="Document title"
              className="mb-6 w-full bg-transparent text-3xl font-semibold leading-tight outline-none placeholder:text-muted-foreground/50"
            />
          )}
          <div ref={rootRef} />
          <UnlinkedNotes view={pmView} parentSlug={handle?.slug ?? null} />
        </div>
      </div>
      {handle && <MarkToolbar selection={selection} ydoc={handle.ydoc} onDismiss={() => setSelection(null)} />}
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
