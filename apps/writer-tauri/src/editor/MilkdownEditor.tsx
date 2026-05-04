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
      onViewReady?.(null)
    }
  }, [handle])

  return (
    <div className="relative h-full w-full">
      {status !== 'connected' && (
        <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-center py-1 text-xs text-muted-foreground">
          {status === 'initializing' && 'Starting proof-server…'}
          {status === 'connecting' && 'Connecting WebSocket…'}
          {status === 'error' && 'proof-server connection failed — restart the app'}
        </div>
      )}
      <div className="h-full w-full overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="mx-auto max-w-2xl px-8 py-12">
          <div ref={rootRef} />
        </div>
      </div>
      {handle && <MarkToolbar selection={selection} ydoc={handle.ydoc} onDismiss={() => setSelection(null)} />}
    </div>
  )
}
