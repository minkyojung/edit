import React, { useEffect, useMemo, useRef, useState } from 'react'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { useDebouncedText } from './hooks/useIdleCallback'
import { MilkdownEditor } from './MilkdownEditor'
import { HugeiconsIcon } from '@hugeicons/react'
import { BookOpen01Icon } from '@hugeicons/core-free-icons'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { AccountMenu } from '@/components/account-menu'
import { AgentSettingsChip } from '@/components/agent-settings-chip'
import { SignInPanel } from '@/components/sign-in-panel'
import { WikiModal } from '@/components/wiki-modal'

export default function App(): React.ReactElement {
  const ydoc = useMemo(() => new Y.Doc(), [])
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null)

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
        onSynced: () => { console.log('[collab] synced'); setCollabSynced(true) },
        onAuthenticationFailed: ({ reason }) => console.error('[collab] auth failed:', reason)
      })
      setProvider(p)
    }).catch((err) => console.error('[collab] failed to get session', err))

    return () => {
      p?.destroy()
    }
  }, [ydoc])

  const [collabSynced, setCollabSynced] = useState(false)
  const [agentError, setAgentError] = useState<string | null>(null)
  const [wikiOpen, setWikiOpen] = useState(false)
  const [oauthStatus, setOauthStatus] = useState<'authenticated' | 'unauthenticated' | 'checking'>('checking')
  const [serverError, setServerError] = useState(false)
  const [editorMarkdown, setEditorMarkdown] = useState<string | null>(null)
  const editorMarkdownRef = useRef<string | null>(null)
  const listenersAdded = useRef(false)

  useEffect(() => {
    window.auth.oauthStatus().then(setOauthStatus)
    const offChanged = window.auth.onChanged(setOauthStatus)
    const offRequired = window.auth.onRequired(() => setOauthStatus('unauthenticated'))
    window.server.onError(() => setServerError(true))
    return () => {
      offChanged()
      offRequired()
    }
  }, [])

  useEffect(() => {
    if (listenersAdded.current) return
    listenersAdded.current = true
    window.agent.onError((msg) => {
      setAgentError(msg)
      setTimeout(() => setAgentError(null), 5000)
    })
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'e' || e.key === 'E')) {
        const md = editorMarkdownRef.current
        if (!md?.trim()) return
        e.preventDefault()
        e.stopPropagation()
        setAgentError(null)
        window.agent.trigger(md, [])
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [])

  useDebouncedText(editorMarkdown, 2000, (text) => {
    if (!text.trim()) return
    setAgentError(null)
    window.agent.trigger(text, [])
  })

  if (oauthStatus === 'checking') {
    return <div className="dark fixed inset-0 z-50 bg-background" />
  }

  return (
    <div className="flex h-screen">
      <div className="relative flex-1 overflow-y-auto px-10 py-12">
        <MilkdownEditor ydoc={ydoc} provider={provider} collabSynced={collabSynced} onMarkdownChange={(md) => { editorMarkdownRef.current = md; setEditorMarkdown(md) }} />
      </div>
      <header className="fixed top-3 right-3 z-40 flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setWikiOpen(true)}
              aria-label="글쓰기 스타일 위키 열기"
            >
              <HugeiconsIcon icon={BookOpen01Icon} className="size-4" strokeWidth={2} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>글쓰기 스타일 위키</TooltipContent>
        </Tooltip>
        {oauthStatus === 'authenticated' && <AccountMenu />}
      </header>
      {oauthStatus === 'authenticated' && <AgentSettingsChip />}
      {agentError && (
        <div className="fixed bottom-12 left-4 text-xs text-destructive font-sans">
          에이전트 오류 — 잠시 후 다시 시도해주세요
        </div>
      )}
      {serverError && (
        <div className="fixed bottom-12 left-4 text-xs text-destructive font-sans">
          서버 연결 실패 — 앱을 재시작해주세요
        </div>
      )}
      {oauthStatus === 'unauthenticated' && <SignInPanel />}
      {wikiOpen && <WikiModal onClose={() => setWikiOpen(false)} />}
    </div>
  )
}
