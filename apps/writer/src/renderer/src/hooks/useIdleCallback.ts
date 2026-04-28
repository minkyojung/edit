import { useEffect, useRef } from 'react'
import type { Editor } from '@tiptap/react'

export function useIdleCallback(
  editor: Editor | null,
  delay: number,
  callback: (editor: Editor) => void
): void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const callbackRef = useRef(callback)
  callbackRef.current = callback

  useEffect(() => {
    if (!editor) return

    const handleUpdate = (): void => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        callbackRef.current(editor)
      }, delay)
    }

    editor.on('update', handleUpdate)

    return () => {
      editor.off('update', handleUpdate)
      if (timer.current) clearTimeout(timer.current)
    }
  }, [editor, delay])
}
