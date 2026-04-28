import React, { useEffect, useRef } from 'react'
import { Editor, rootCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { collab, collabServiceCtx } from '@milkdown/plugin-collab'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react'
import { testMarkPlugin } from './markPlugin'
import * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'

type Props = {
  ydoc: Y.Doc
  provider: HocuspocusProvider | null
  onMarkdownChange?: (markdown: string) => void
}

function MilkdownInner({ ydoc, provider, onMarkdownChange }: Props): React.ReactElement {
  const connectedRef = useRef(false)
  const onMarkdownChangeRef = useRef(onMarkdownChange)
  onMarkdownChangeRef.current = onMarkdownChange

  const { get } = useEditor((root) =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root)
      })
      .config((ctx) => {
        ctx.get(listenerCtx).markdownUpdated((_, md) => {
          onMarkdownChangeRef.current?.(md)
        })
      })
      .use(commonmark)
      .use(listener)
      .use(collab)
      .use(testMarkPlugin)
  )

  useEffect(() => {
    if (connectedRef.current) return
    const editor = get()
    if (!editor) return

    editor.action((ctx) => {
      const service = ctx.get(collabServiceCtx)
      service.bindDoc(ydoc)
      if (provider) {
        service.setOptions({ awareness: provider.awareness })
      }
      service.connect()
      connectedRef.current = true
    })
  }, [get, ydoc, provider])

  return <Milkdown />
}

export function MilkdownEditor(props: Props): React.ReactElement {
  return (
    <MilkdownProvider>
      <MilkdownInner {...props} />
    </MilkdownProvider>
  )
}
