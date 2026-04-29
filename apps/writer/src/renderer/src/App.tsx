import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { useDebouncedText } from './hooks/useIdleCallback'
import { MilkdownEditor } from './MilkdownEditor'
import { HugeiconsIcon } from '@hugeicons/react'
import { BookOpen01Icon, User02Icon } from '@hugeicons/core-free-icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
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
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'

function AccountMenu(): React.ReactElement {
  const handleSignOut = useCallback(async () => {
    await window.auth.logout()
  }, [])

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Account menu">
              <Avatar className="size-7">
                <AvatarFallback>
                  <HugeiconsIcon icon={User02Icon} className="size-4" strokeWidth={2} />
                </AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Connected to Claude</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
          Connected to Claude
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleSignOut}>Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
    <div className="dark fixed inset-0 z-50 flex items-center justify-center bg-background font-sans">
      <div className="flex flex-col items-center text-center max-w-sm">
        {!awaitingPaste ? (
          <>
            <Button onClick={handleSignIn} size="lg">
              Sign in with Claude
            </Button>
            <p className="text-foreground text-base leading-relaxed mt-7 font-normal">
              Use your existing Anthropic<br />subscription to use the agent panel.
            </p>
            <p className="text-muted-foreground text-sm mt-4">
              — More models will be added.
            </p>
          </>
        ) : (
          <div className="flex flex-col items-stretch gap-3 w-80 mt-4">
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
              <p className="text-destructive text-xs text-center mt-1 break-words">
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
      <DialogContent onKeyDown={handleKeyDown} className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>글쓰기 스타일 위키</DialogTitle>
          <DialogDescription>
            ⌘S로 저장 · 저장 시 에이전트 세션이 갱신됩니다
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center justify-center text-sm text-muted-foreground py-16">
            불러오는 중...
          </div>
        ) : error && !markdown ? (
          <div className="flex items-center justify-center text-sm text-destructive py-16">
            {error}
          </div>
        ) : (
          <Textarea
            className="font-mono text-sm leading-relaxed min-h-[320px] resize-none rounded-xl"
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            autoFocus
            spellCheck={false}
          />
        )}
        <DialogFooter>
          {error && markdown && (
            <span className="text-destructive text-xs mr-auto self-center">{error}</span>
          )}
          <Button
            onClick={handleSave}
            disabled={saving || loading}
          >
            {saving ? '저장 중...' : '저장'}
          </Button>
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
    return <div className="dark fixed inset-0 z-50 bg-background" />
  }

  return (
    <div className="flex h-screen">
      <div className="relative flex-1 overflow-y-auto px-10 py-12">
        <MilkdownEditor ydoc={ydoc} provider={provider} onMarkdownChange={setEditorMarkdown} />
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
      {oauthStatus === 'unauthenticated' && <SignInPanel />}
      {wikiOpen && <WikiModal onClose={() => setWikiOpen(false)} />}
    </div>
  )
}
