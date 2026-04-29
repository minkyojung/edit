import React, { useEffect, useRef } from 'react'
import { collabServiceCtx } from '@milkdown/plugin-collab'
import { listenerCtx } from '@milkdown/kit/plugin/listener'
import { editorViewCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import type { EditorView } from '@milkdown/kit/prose/view'
import { ProofEditorImpl } from 'proof-sdk/src/editor/index.js'
import { applyRemoteMarks } from 'proof-sdk/src/editor/plugins/marks.js'
import type { StoredMark } from 'proof-sdk/src/formats/marks.js'

import * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'

const POLL_INTERVAL_MS = 1500

type Props = {
  ydoc: Y.Doc
  provider: HocuspocusProvider | null
  onMarkdownChange?: (markdown: string) => void
}

export function MilkdownEditor({ ydoc, provider, onMarkdownChange }: Props): React.ReactElement {
  const rootRef = useRef<HTMLDivElement>(null)
  const proofRef = useRef<ProofEditorImpl | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onMarkdownChangeRef = useRef(onMarkdownChange)
  onMarkdownChangeRef.current = onMarkdownChange

  useEffect(() => {
    if (!rootRef.current) return
    const proof = new ProofEditorImpl()
    proofRef.current = proof

    let mounted = true

    proof.init(rootRef.current).then(() => {
      if (!mounted || !proof.editor) return

      proof.editor.action((ctx: Ctx) => {
        viewRef.current = ctx.get(editorViewCtx)

        ctx.get(listenerCtx).markdownUpdated((_: Ctx, md: string) => {
          onMarkdownChangeRef.current?.(md)
        })

        const svc = ctx.get(collabServiceCtx)
        svc.disconnect()
        try {
          ;(svc as unknown as { setAwareness(a: unknown): void }).setAwareness(null)
        } catch { /* ignore */ }
        svc.bindDoc(ydoc)
        svc.connect()
      })
    })

    return () => {
      mounted = false
      viewRef.current = null
      proof.editor?.action((ctx: Ctx) => {
        ctx.get(collabServiceCtx).disconnect()
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const id = setInterval(async () => {
      const view = viewRef.current
      if (!view) return
      try {
        const state = await window.marks.fetchState()
        if (state?.marks) {
          applyRemoteMarks(view, state.marks as Record<string, StoredMark>)
        }
      } catch {
        // server not ready yet — will retry next tick
      }
    }, POLL_INTERVAL_MS)

    return () => clearInterval(id)
  }, [])

  return <div ref={rootRef} className="h-full w-full" />
}
