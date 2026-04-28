import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { useDebouncedText } from './hooks/useIdleCallback'
import { MilkdownEditor } from './MilkdownEditor'

function WikiModal({ onClose }: { onClose: () => void }): React.ReactElement {
  const [markdown, setMarkdown] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.wiki.read()
      .then((md) => {
        setMarkdown(md)
        setLoading(false)
      })
      .catch(() => {
        setError('위키를 불러오지 못했습니다. 서버 연결을 확인해주세요.')
        setLoading(false)
      })
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      await window.wiki.save(markdown)
      onClose()
    } catch {
      setError('저장에 실패했습니다. 서버 연결을 확인해주세요.')
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
        ) : error && !markdown ? (
          <div className="modal-loading modal-error">{error}</div>
        ) : (
          <textarea
            className="wiki-textarea"
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            autoFocus
            spellCheck={false}
          />
        )}
        <div className="modal-hint">
          {error && markdown ? <span className="modal-hint-error">{error} · </span> : null}
          ⌘S로 저장 · 저장 시 에이전트 세션이 갱신됩니다
        </div>
      </div>
    </div>
  )
}

export default function App(): React.ReactElement {
  const ydoc = useMemo(() => new Y.Doc(), [])
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null)

  useEffect(() => {
    const marksMap = ydoc.getMap('marks')
    const log = (): void => {
      const entries: Record<string, unknown> = {}
      marksMap.forEach((v, k) => { entries[k] = v })
      console.log('[marks]', Object.keys(entries).length, entries)
    }
    log()
    marksMap.observe(log)
    return () => marksMap.unobserve(log)
  }, [ydoc])

  useEffect(() => {
    let p: HocuspocusProvider | null = null
    window.doc.collabSession().then(({ collabWsUrl, token, slug }) => {
      const url = new URL(collabWsUrl)
      url.searchParams.set('slug', slug)
      url.searchParams.set('token', token)
      url.searchParams.set('role', 'editor')
      p = new HocuspocusProvider({
        url: url.toString(),
        name: slug,
        document: ydoc,
        token: () => token,
        onSynced: () => console.log('[collab] synced'),
        onAuthenticationFailed: ({ reason }) => console.error('[collab] auth failed:', reason)
      })
      setProvider(p)
    }).catch((err) => console.error('[collab] failed to get session', err))

    return () => {
      p?.destroy()
    }
  }, [ydoc])

  const [suggestion, setSuggestion] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [agentError, setAgentError] = useState<string | null>(null)
  const [wikiOpen, setWikiOpen] = useState(false)
  const [authStatus, setAuthStatus] = useState<'ok' | 'not-installed' | 'not-logged-in' | 'checking'>('checking')
  const [loggingIn, setLoggingIn] = useState(false)
  const [serverError, setServerError] = useState(false)
  const [editorMarkdown, setEditorMarkdown] = useState<string | null>(null)
  const listenersAdded = useRef(false)

  useEffect(() => {
    window.auth.status().then(setAuthStatus)
    window.server.onError(() => setServerError(true))
  }, [])

  const handleLogin = useCallback(async () => {
    setLoggingIn(true)
    try {
      const result = await window.auth.login()
      setAuthStatus(result)
    } finally {
      setLoggingIn(false)
    }
  }, [])

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

    window.agent.onError((msg) => {
      setAgentError(msg)
      setStreaming(false)
    })
  }, [])

  useDebouncedText(editorMarkdown, 1500, (text) => {
    if (!text.trim()) return
    setSuggestion('')
    setAgentError(null)
    setStreaming(true)
    window.agent.trigger(text)
  })

  return (
    <div className="app">
      <div className="editor-pane">
        <button className="wiki-btn" onClick={() => setWikiOpen(true)} title="글쓰기 스타일 위키">
          ✦
        </button>
        <MilkdownEditor ydoc={ydoc} provider={provider} onMarkdownChange={setEditorMarkdown} />
      </div>
      {(suggestion || streaming || agentError) && (
        <div className="suggestion-pane">
          <div className="suggestion-label">제안</div>
          {agentError ? (
            <div className="suggestion-error">에이전트 오류가 발생했습니다. 잠시 후 다시 시도해주세요.</div>
          ) : (
            <div className="suggestion-text">
              {suggestion}
              {streaming && <span className="cursor" />}
            </div>
          )}
        </div>
      )}
      {serverError && (
        <div className="auth-status auth-status--error">
          서버 연결 실패 — 앱을 재시작해주세요
        </div>
      )}
      {authStatus === 'not-installed' && (
        <div className="auth-status">
          Claude CLI가 설치되어 있지 않습니다 —{' '}
          <a href="https://claude.ai/download" target="_blank" rel="noreferrer">설치하기</a>
        </div>
      )}
      {authStatus === 'not-logged-in' && (
        <button className="auth-status auth-status--clickable" onClick={handleLogin} disabled={loggingIn}>
          {loggingIn ? '로그인 중...' : 'Claude 로그인이 필요합니다 — 클릭하여 로그인'}
        </button>
      )}
      {wikiOpen && <WikiModal onClose={() => setWikiOpen(false)} />}
    </div>
  )
}
