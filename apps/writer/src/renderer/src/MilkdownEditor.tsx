import React, { useEffect, useRef } from 'react'
import {
  Editor,
  rootCtx,
  editorViewCtx,
  parserCtx,
  remarkStringifyOptionsCtx
} from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { collab, collabServiceCtx } from '@milkdown/plugin-collab'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react'

import { proofMarkPlugins } from 'proof-sdk/src/editor/schema/proof-marks.js'
import { remarkProofMarksPlugin } from 'proof-sdk/src/editor/schema/remark-proof-marks-plugin.js'
import { proofMarkHandler } from 'proof-sdk/src/formats/remark-proof-marks.js'
import {
  marksPlugins,
  marksPluginKey,
  getMarks,
  getMarkMetadata,
  setDefaultMarkdownParser,
  applyRemoteMarks
} from 'proof-sdk/src/editor/plugins/marks.js'
import { authoredTrackerPlugin } from 'proof-sdk/src/editor/plugins/authored-tracker.js'
import { marksSyncPlugin } from 'proof-sdk/src/editor/plugins/marks-sync.js'

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
        // proofMark mdast 노드 → markdown 직렬화 핸들러.
        // schema 의 toMarkdown 이 만든 proofMark 노드를 <span data-proof="..."> 로 변환.
        ctx.update(remarkStringifyOptionsCtx, (prev) => ({
          ...prev,
          handlers: {
            ...(prev.handlers ?? {}),
            proofMark: proofMarkHandler
          }
        }))
      })
      .config((ctx) => {
        ctx.get(listenerCtx).markdownUpdated((_, md) => {
          onMarkdownChangeRef.current?.(md)
        })
      })
      .use(commonmark)
      .use(listener)
      .use(collab)
      // proof-sdk: schema 마크 5종 + remark plugin (markdown ↔ mdast)
      .use(proofMarkPlugins)
      .use(remarkProofMarksPlugin)
      // proof-sdk: 사용자 입력에 proofAuthored mark 자동 부여
      .use(authoredTrackerPlugin)
      // proof-sdk: 마크 metadata + decoration 통합 plugin
      .use(marksPlugins)
      // 마크 변경 옵저버 — 향후 카운터 chip / 사이드바 업데이트용
      .use(marksSyncPlugin(() => {
        // step 4 에서 UI hook 추가 예정
      }))
  )

  // Effect A — collab 연결 + parser 등록. 1회성 (connectedRef gate).
  useEffect(() => {
    if (connectedRef.current) return
    const editor = get()
    if (!editor) return

    editor.action((ctx) => {
      const parser = ctx.get(parserCtx)
      setDefaultMarkdownParser(parser)

      const service = ctx.get(collabServiceCtx)
      service.bindDoc(ydoc)
      if (provider?.awareness) {
        service.setAwareness(provider.awareness)
      }
      service.connect()
      connectedRef.current = true
    })
  }, [get, ydoc, provider])

  // Effect B — Y.Doc → 인라인 PM 마크 브릿지. **gate 없음** —
  // StrictMode 의 mount/unmount/remount 사이에서 옵저버가 정확히 다시 등록되도록.
  // proof-sdk 서버는 agent suggest_* 시 marks Y.Map 에 entry 를 추가한다. 우리는
  // ydoc.on('update') 로 변경을 감지해 applyRemoteMarks 로 인라인 마크로 변환.
  useEffect(() => {
    const editor = get()
    if (!editor) return

    let cleanup: (() => void) | null = null

    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const marksMap = ydoc.getMap('marks')
      let lastSerialized = ''

      const sync = (): void => {
        const metadata: Record<string, unknown> = {}
        marksMap.forEach((value, key) => {
          metadata[key] = value
        })
        const serialized = JSON.stringify(Object.keys(metadata).sort().map((k) => [k, metadata[k]]))
        if (serialized === lastSerialized) return
        lastSerialized = serialized
        console.log('[marks-sync] firing, ymap entries:', Object.keys(metadata).length, metadata)
        applyRemoteMarks(view, metadata as never)
        const after = getMarks(view.state)
        console.log('[marks-sync] after applyRemoteMarks, getMarks count:', after.length, after)
      }

      sync()
      const onUpdate = (): void => sync()
      ydoc.on('update', onUpdate)
      cleanup = () => ydoc.off('update', onUpdate)

      // Debug helper
      ;(window as unknown as { __dbg: () => unknown }).__dbg = () => {
        const v = ctx.get(editorViewCtx)
        const ymapEntries: Record<string, unknown> = {}
        marksMap.forEach((val, key) => {
          ymapEntries[key] = val
        })
        return {
          ymapMarksCount: marksMap.size,
          ymapEntries,
          pluginMetadata: getMarkMetadata(v.state),
          pluginMarks: getMarks(v.state),
          schemaHasProofSuggestion: !!v.state.schema.marks.proofSuggestion,
          schemaHasProofComment: !!v.state.schema.marks.proofComment,
          schemaHasProofAuthored: !!v.state.schema.marks.proofAuthored,
          docText: v.state.doc.textContent.slice(0, 200),
          docSize: v.state.doc.content.size,
          inlineProofSpans: document.querySelectorAll('[data-proof]').length
        }
      }
    })

    return () => {
      cleanup?.()
    }
  }, [get, ydoc])

  return <Milkdown />
}

export function MilkdownEditor(props: Props): React.ReactElement {
  return (
    <MilkdownProvider>
      <MilkdownInner {...props} />
    </MilkdownProvider>
  )
}
