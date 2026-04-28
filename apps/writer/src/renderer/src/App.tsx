import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useIdleCallback } from './hooks/useIdleCallback'

function WikiModal({ onClose }: { onClose: () => void }): React.ReactElement {
  const [markdown, setMarkdown] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.wiki.read().then((md) => {
      setMarkdown(md)
      setLoading(false)
    })
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      await window.wiki.save(markdown)
      onClose()
    } finally {
      setSaving(false)
    }
  }, [markdown, onClose])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
      if (e.key === 'Escape') onClose()
    },
    [handleSave, onClose]
  )

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="modal-header">
          <span className="modal-title">글쓰기 스타일 위키</span>
          <div className="modal-actions">
            <button className="modal-save" onClick={handleSave} disabled={saving || loading}>
              {saving ? '저장 중...' : '저장'}
            </button>
            <button className="modal-close" onClick={onClose}>✕</button>
          </div>
        </div>
        {loading ? (
          <div className="modal-loading">불러오는 중...</div>
        ) : (
          <textarea
            className="wiki-textarea"
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            autoFocus
            spellCheck={false}
          />
        )}
        <div className="modal-hint">⌘S로 저장 · 저장 시 에이전트 세션이 갱신됩니다</div>
      </div>
    </div>
  )
}

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
  const [wikiOpen, setWikiOpen] = useState(false)
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
        <button className="wiki-btn" onClick={() => setWikiOpen(true)} title="글쓰기 스타일 위키">
          ✦
        </button>
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
      {wikiOpen && <WikiModal onClose={() => setWikiOpen(false)} />}
    </div>
  )
}
