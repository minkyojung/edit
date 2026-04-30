import { useEffect, useRef, useCallback } from 'react'
import { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'

const STORAGE_KEY = 'writer-tauri:editor-content'
const DEBOUNCE_MS = 400

function loadContent(): string {
  return localStorage.getItem(STORAGE_KEY) ?? '# 새 문서\n\n여기에 글을 써보세요.\n'
}

function saveContent(markdown: string) {
  localStorage.setItem(STORAGE_KEY, markdown)
}

interface Props {
  onMarkdownChange?: (md: string) => void
}

export function MilkdownEditor({ onMarkdownChange }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Editor | null>(null)
  const onChangeRef = useRef(onMarkdownChange)
  onChangeRef.current = onMarkdownChange

  const destroyEditor = useCallback(() => {
    if (editorRef.current) {
      editorRef.current.destroy()
      editorRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!rootRef.current) return

    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let mounted = true

    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, rootRef.current!)
        ctx.set(defaultValueCtx, loadContent())
        ctx.set(editorViewOptionsCtx, { attributes: { class: 'milkdown-editor-root' } })

        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
          if (!mounted) return
          if (debounceTimer) clearTimeout(debounceTimer)
          debounceTimer = setTimeout(() => {
            saveContent(markdown)
            onChangeRef.current?.(markdown)
          }, DEBOUNCE_MS)
        })
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(clipboard)
      .use(listener)
      .create()
      .then((editor) => {
        if (!mounted) {
          editor.destroy()
          return
        }
        editorRef.current = editor
      })

    return () => {
      mounted = false
      if (debounceTimer) clearTimeout(debounceTimer)
      destroyEditor()
    }
  }, [destroyEditor])

  return (
    <div className="h-full w-full overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="mx-auto max-w-2xl px-8 py-12">
        <div ref={rootRef} />
      </div>
    </div>
  )
}
