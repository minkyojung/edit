import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { useDebouncedText } from './hooks/useIdleCallback'
import { MilkdownEditor } from './MilkdownEditor'
import { CircleUserRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'

function AccountIndicator(): React.ReactElement {
  const handleSignOut = useCallback(async () => {
    await window.auth.logout()
  }, [])

  return (
    <div className="account-indicator">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            title="Connected to Claude"
          >
            <CircleUserRound className="h-5 w-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
            Connected to Claude
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleSignOut}>
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function SignInPanel(): React.ReactElement {
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [awaitingPaste, setAwaitingPaste] = useState(false)

  const handleSignIn = useCallback(async () => {
    setError(null)
    try {
      await window.auth.oauthStart()
      setAwaitingPaste(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const handleSubmit = useCallback(async () => {
    if (!code.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      await window.auth.oauthComplete(code.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }, [code])

  return (
    <div className="dark fixed inset-0 z-[100] flex items-center justify-center bg-background font-sans">
      <div className="flex flex-col items-center text-center max-w-[360px]">
        {!awaitingPaste ? (
          <>
            <Button onClick={handleSignIn} size="lg">
              Sign in with Claude
            </Button>
            <p className="text-foreground text-[17px] leading-relaxed mt-7 font-normal">
              Use your existing Anthropic<br />subscription to use the agent panel.
            </p>
            <p className="text-muted-foreground text-[15px] mt-[18px]">
              — More models will be added.
            </p>
          </>
        ) : (
          <div className="flex flex-col items-stretch gap-3 w-[320px] mt-4">
            <p className="text-foreground text-sm text-center mb-1">
              Paste the authorization code from your browser
            </p>
            <Input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Paste code here"
              autoFocus
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSubmit()
              }}
            />
            <Button
              onClick={handleSubmit}
              disabled={submitting || !code.trim()}
              size="lg"
            >
              {submitting ? 'Connecting...' : 'Connect'}
            </Button>
            {error && (
              <p className="text-destructive text-[13px] text-center mt-1 break-words">
                {error}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

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
    },
    [handleSave]
  )

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent onKeyDown={handleKeyDown}>
        <DialogHeader>
          <DialogTitle>글쓰기 스타일 위키</DialogTitle>
          <Button
            variant="default"
            size="sm"
            onClick={handleSave}
            disabled={saving || loading}
            className="mr-7"
          >
            {saving ? '저장 중...' : '저장'}
          </Button>
        </DialogHeader>
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
        <DialogFooter>
          {error && markdown ? <span className="modal-hint-error">{error} · </span> : null}
          ⌘S로 저장 · 저장 시 에이전트 세션이 갱신됩니다
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

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
        onSynced: () => console.log('[collab] synced'),
        onAuthenticationFailed: ({ reason }) => console.error('[collab] auth failed:', reason)
      })
      setProvider(p)
    }).catch((err) => console.error('[collab] failed to get session', err))

    return () => {
      p?.destroy()
    }
  }, [ydoc])

  const [agentError, setAgentError] = useState<string | null>(null)
  const [wikiOpen, setWikiOpen] = useState(false)
  const [oauthStatus, setOauthStatus] = useState<'authenticated' | 'unauthenticated' | 'checking'>('checking')
  const [serverError, setServerError] = useState(false)
  const [editorMarkdown, setEditorMarkdown] = useState<string | null>(null)
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

  useDebouncedText(editorMarkdown, 1500, (text) => {
    if (!text.trim()) return
    setAgentError(null)
    window.agent.trigger(text)
  })

  if (oauthStatus === 'checking') {
    return <div className="fixed inset-0 z-[200] bg-zinc-950" />
  }

  return (
    <div className="flex h-screen">
      <div className="relative flex-1 overflow-y-auto px-10 py-12">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setWikiOpen(true)}
          title="글쓰기 스타일 위키"
          className="absolute right-4 top-4 text-muted-foreground text-lg"
        >
          ✦
        </Button>
        <MilkdownEditor ydoc={ydoc} provider={provider} onMarkdownChange={setEditorMarkdown} />
      </div>
      {agentError && (
        <div className="fixed bottom-4 left-4 text-xs text-destructive font-sans">
          에이전트 오류 — 잠시 후 다시 시도해주세요
        </div>
      )}
      {serverError && (
        <div className="fixed bottom-4 left-4 text-xs text-destructive font-sans">
          서버 연결 실패 — 앱을 재시작해주세요
        </div>
      )}
      {oauthStatus === 'authenticated' && <AccountIndicator />}
      {oauthStatus === 'unauthenticated' && <SignInPanel />}
      {wikiOpen && <WikiModal onClose={() => setWikiOpen(false)} />}
    </div>
  )
}
