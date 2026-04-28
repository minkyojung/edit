import React, { useEffect, useRef, useState } from 'react'
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

  const [suggestion, setSuggestion] = useState('')
  const [streaming, setStreaming] = useState(false)
  const listenersAdded = useRef(false)

  useEffect(() => {
    if (listenersAdded.current) return
    listenersAdded.current = true

    window.agent.onChunk((text) => {
      setSuggestion((prev) => prev + text)
      setStreaming(true)
    })

    window.agent.onDone(() => {
      setStreaming(false)
    })
  }, [])

  useIdleCallback(editor, 1500, (e) => {
    const text = e.getText()
    if (!text.trim()) return
    setSuggestion('')
    setStreaming(true)
    window.agent.trigger(text)
  })

  return (
    <div className="app">
      <div className="editor-pane">
        <EditorContent editor={editor} />
      </div>
      {(suggestion || streaming) && (
        <div className="suggestion-pane">
          <div className="suggestion-label">제안</div>
          <div className="suggestion-text">
            {suggestion}
            {streaming && <span className="cursor" />}
          </div>
        </div>
      )}
    </div>
  )
}
