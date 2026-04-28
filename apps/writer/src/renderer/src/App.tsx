import React from 'react'
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

  useIdleCallback(editor, 1500, (e) => {
    const text = e.getText()
    if (!text.trim()) return
    console.log('[idle] 트리거 — 에이전트 호출 예정', { chars: text.length })
  })

  return (
    <div className="app">
      <EditorContent editor={editor} />
    </div>
  )
}
