import React, { useEffect, useRef } from 'react'
import { collabServiceCtx } from '@milkdown/plugin-collab'
import { editorViewCtx, parserCtx, serializerCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import type { EditorView } from '@milkdown/kit/prose/view'
import { ProofEditorImpl } from 'proof-sdk/src/editor/index.js'
import {
  applyRemoteMarks,
  accept as acceptLocal,
  reject as rejectLocal,
  acceptAll as acceptAllLocal,
  getMarks,
  getActiveMarkId
} from 'proof-sdk/src/editor/plugins/marks.js'
import type { StoredMark, Mark } from 'proof-sdk/src/formats/marks.js'

import * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'

const POLL_INTERVAL_MS = 1500
const MARKDOWN_DEBOUNCE_MS = 200
const ACTIONABLE_KINDS = new Set(['insert', 'delete', 'replace'])

type Props = {
  ydoc: Y.Doc
  provider: HocuspocusProvider | null
  onMarkdownChange?: (markdown: string) => void
}

type Serializer = (doc: unknown) => string

function isActionable(mark: Mark): boolean {
  return ACTIONABLE_KINDS.has(mark.kind)
}

function pickMarkId(view: EditorView): string | null {
  const state = view.state
  // Prefer an explicitly focused mark (e.g. user clicked it).
  const active = getActiveMarkId(state)
  if (active) return active
  // Otherwise only act if the caret is inside an actionable mark's range.
  // Falling back to the first mark in the doc would let Tab/Esc hijack the
  // editor whenever any pending suggestion exists, breaking normal editing.
  const cursor = state.selection.from
  const atCursor = getMarks(state)
    .filter(isActionable)
    .find((m) => m.range && cursor >= m.range.from && cursor <= m.range.to)
  return atCursor?.id ?? null
}

export function MilkdownEditor({ ydoc, provider, onMarkdownChange }: Props): React.ReactElement {
  const rootRef = useRef<HTMLDivElement>(null)
  const proofRef = useRef<ProofEditorImpl | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const parserRef = useRef<unknown>(null)
  const serializerRef = useRef<Serializer | null>(null)
  const onMarkdownChangeRef = useRef(onMarkdownChange)
  onMarkdownChangeRef.current = onMarkdownChange

  useEffect(() => {
    if (!rootRef.current) return
    const proof = new ProofEditorImpl()
    proofRef.current = proof

    let mounted = true
    let detachKeys: (() => void) | null = null
    let detachYdoc: (() => void) | null = null
    let mdTimer: ReturnType<typeof setTimeout> | null = null

    const emitMarkdown = (): void => {
      const view = viewRef.current
      const serialize = serializerRef.current
      if (!view || !serialize) return
      try {
        const md = serialize(view.state.doc)
        onMarkdownChangeRef.current?.(md)
      } catch (err) {
        console.error('[MilkdownEditor] serialize failed', err)
      }
    }

    const scheduleEmit = (): void => {
      if (mdTimer) clearTimeout(mdTimer)
      mdTimer = setTimeout(emitMarkdown, MARKDOWN_DEBOUNCE_MS)
    }

    proof.init(rootRef.current).then(() => {
      if (!mounted || !proof.editor) return

      proof.editor.action((ctx: Ctx) => {
        const view = ctx.get(editorViewCtx)
        viewRef.current = view
        parserRef.current = ctx.get(parserCtx)
        serializerRef.current = ctx.get(serializerCtx) as Serializer

        const svc = ctx.get(collabServiceCtx)
        svc.disconnect()
        try {
          ;(svc as unknown as { setAwareness(a: unknown): void }).setAwareness(null)
        } catch { /* ignore */ }
        svc.bindDoc(ydoc)
        svc.connect()

        // y-prosemirror tags local edits with addToHistory:false, which
        // suppresses milkdown's listenerCtx callbacks. Observe the ydoc and
        // wrap PM dispatch directly so we still detect every change.
        // See docs/proof-sdk-integration-notes.md §4.
        const onYUpdate = (): void => scheduleEmit()
        ydoc.on('update', onYUpdate)
        detachYdoc = () => ydoc.off('update', onYUpdate)
        const origDispatch = view.dispatch.bind(view)
        ;(view as unknown as { dispatch: (tr: unknown) => void }).dispatch = (tr: unknown): void => {
          origDispatch(tr as never)
          if ((tr as { docChanged?: boolean }).docChanged) scheduleEmit()
        }
        // Emit once after initial sync so debounced consumers see the seed.
        scheduleEmit()

        const handleKeyDown = (e: KeyboardEvent): void => {
          // ⌘⇧C / ⌃⇧C → manually ask the agent to check the current document
          if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'c' || e.key === 'C')) {
            const serialize = serializerRef.current
            if (!serialize) return
            e.preventDefault()
            e.stopPropagation()
            const md = serialize(view.state.doc)
            if (md.trim()) {
              window.agent.trigger(md, [])
            }
            return
          }

          if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'a' || e.key === 'A')) {
            const allIds = getMarks(view.state).filter(isActionable).map((m) => m.id)
            if (allIds.length === 0) return
            e.preventDefault()
            e.stopPropagation()
            acceptAllLocal(view, parserRef.current as never)
            for (const id of allIds) {
              void window.marks.accept(id).catch((err) => console.error('[marks] accept failed', err))
            }
            return
          }

          if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const id = pickMarkId(view)
            if (!id) return
            e.preventDefault()
            e.stopPropagation()
            if (acceptLocal(view, id, parserRef.current as never)) {
              void window.marks.accept(id).catch((err) => console.error('[marks] accept failed', err))
            }
            return
          }

          if (e.key === 'Escape') {
            const id = pickMarkId(view)
            if (!id) return
            e.preventDefault()
            e.stopPropagation()
            if (rejectLocal(view, id)) {
              void window.marks.reject(id).catch((err) => console.error('[marks] reject failed', err))
            }
          }
        }

        view.dom.addEventListener('keydown', handleKeyDown, true)
        detachKeys = () => view.dom.removeEventListener('keydown', handleKeyDown, true)
      })
    })

    return () => {
      mounted = false
      if (mdTimer) clearTimeout(mdTimer)
      detachKeys?.()
      detachYdoc?.()
      viewRef.current = null
      parserRef.current = null
      serializerRef.current = null
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
