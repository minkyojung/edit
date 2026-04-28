import React, { useEffect } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useIdleCallback } from './hooks/useIdleCallback'

export default function App(): React.ReactElement {
  const editor = useEditor({
    extensions: [StarterKit],
    content: '<p></p>',
    autofocus: true,
    editorProps: {
      attributes: {
        'data-placeholder': '글을 입력하세요...'
      }
    }
  })

  useEffect(() => {
    window.agent.onChunk((text) => console.log('[agent chunk]', text))
    window.agent.onDone(() => console.log('[agent done]'))
  }, [])

  useIdleCallback(editor, 1500, (e) => {
    const text = e.getText()
    if (!text.trim()) return
    window.agent.trigger(text)
  })

  return (
    <div className="app">
      <EditorContent editor={editor} />
    </div>
  )
}
