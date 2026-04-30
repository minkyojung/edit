import React, { useEffect, useRef, useState, useCallback } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { FileUIPart } from 'ai'
import { HugeiconsIcon } from '@hugeicons/react'
import { CancelCircleIcon } from '@hugeicons/core-free-icons'

import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionAddScreenshot,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from '@/components/ui/prompt-input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'

const markdownComponents: React.ComponentProps<typeof Markdown>['components'] = {
  p: ({ children }) => <p className="leading-relaxed">{children}</p>,
  h1: ({ children }) => <h1 className="text-base font-semibold text-foreground mt-4 mb-1">{children}</h1>,
  h2: ({ children }) => <h2 className="text-sm font-semibold text-foreground mt-3 mb-1">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-medium text-foreground mt-2 mb-1">{children}</h3>,
  hr: () => <hr className="border-border my-3" />,
  ul: ({ children }) => <ul className="space-y-1 pl-4">{children}</ul>,
  ol: ({ children }) => <ol className="space-y-1 pl-4 list-decimal">{children}</ol>,
  li: ({ children }) => <li className="text-foreground before:content-['•'] before:mr-2 before:text-muted-foreground list-none">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ children, className }) => {
    const isBlock = className?.includes('language-')
    if (isBlock) return (
      <code className="block bg-muted text-foreground text-xs rounded-md px-3 py-2 overflow-x-auto font-mono whitespace-pre">{children}</code>
    )
    return <code className="bg-muted text-foreground text-xs rounded px-1 py-0.5 font-mono">{children}</code>
  },
  pre: ({ children }) => <pre className="bg-muted rounded-md overflow-x-auto">{children}</pre>,
  blockquote: ({ children }) => <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>,
  table: ({ children }) => <table className="w-full text-xs border-collapse">{children}</table>,
  thead: ({ children }) => <thead>{children}</thead>,
  th: ({ children }) => <th className="border border-border px-2 py-1.5 text-left font-medium text-muted-foreground">{children}</th>,
  td: ({ children }) => <td className="border border-border px-2 py-1.5 text-foreground">{children}</td>,
  a: ({ children, href }) => <a href={href} className="underline underline-offset-2 text-foreground">{children}</a>,
}

const CHAT_EFFORTS = ['low', 'medium', 'high'] as const
type ChatEffort = typeof CHAT_EFFORTS[number]

// Each tuple: [inner ring, middle ring, outer ring] opacity
const EFFORT_OPACITIES: Record<ChatEffort, [number, number, number]> = {
  low:    [1, 0.2, 0.2],
  medium: [1, 1,   0.2],
  high:   [1, 1,   1],
}

function EffortButton({ effort, onClick }: { effort: ChatEffort; onClick: () => void }) {
  const [inner, middle, outer] = EFFORT_OPACITIES[effort]
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center justify-center p-1 text-muted-foreground hover:text-foreground transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 rounded-sm"
      title={effort}
    >
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" opacity={outer} style={{ transition: 'opacity 0.15s' }} />
        <circle cx="12" cy="12" r="6"  opacity={middle} style={{ transition: 'opacity 0.15s' }} />
        <circle cx="12" cy="12" r="2"  opacity={inner} style={{ transition: 'opacity 0.15s' }} />
      </svg>
    </button>
  )
}

const MODEL_LABELS: Record<AgentModelId, string> = {
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-opus-4-7': 'Opus 4.7',
}

function AttachmentPreview() {
  const { files, remove } = usePromptInputAttachments()
  if (files.length === 0) return null
  return (
    <PromptInputHeader>
      {files.map((f) => (
        <div key={f.id} className="relative inline-block">
          {f.mediaType.startsWith('image/') ? (
            <img
              src={f.url}
              alt={f.filename ?? 'attachment'}
              className="h-16 w-16 rounded-md object-cover"
            />
          ) : (
            <div className="flex h-16 w-16 flex-col items-center justify-center gap-1 rounded-md bg-accent text-center">
              <span className="text-[10px] font-semibold uppercase text-muted-foreground">
                {f.mediaType === 'application/pdf' ? 'PDF' : f.mediaType.startsWith('text/') ? 'TXT' : 'FILE'}
              </span>
              <span className="line-clamp-2 px-1 text-[9px] text-muted-foreground">
                {f.filename ?? 'file'}
              </span>
            </div>
          )}
          <button
            type="button"
            onClick={() => remove(f.id)}
            className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-foreground text-background"
          >
            <HugeiconsIcon icon={CancelCircleIcon} className="size-2.5" />
          </button>
        </div>
      ))}
    </PromptInputHeader>
  )
}

interface ChatFile {
  url: string
  mediaType: string
  filename?: string
}

interface Props {
  documentContext: string | null
  oauthStatus: 'authenticated' | 'unauthenticated' | 'checking'
}

export function ContextPanel({ documentContext, oauthStatus }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [status, setStatus] = useState<'idle' | 'streaming'>('idle')
  const [model, setModel] = useState<AgentModelId>('claude-sonnet-4-6')
  const [effort, setEffort] = useState<ChatEffort>('low')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const offChunk = window.agent.onChatChunk((chunk) => {
      setMessages((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last?.role === 'assistant') {
          next[next.length - 1] = { ...last, content: last.content + chunk }
        }
        return next
      })
    })
    const offDone = window.agent.onChatDone(() => setStatus('idle'))
    const offError = window.agent.onChatError(() => setStatus('idle'))
    return () => {
      offChunk()
      offDone()
      offError()
    }
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSubmit = useCallback(
    ({ text, files }: { text: string; files: FileUIPart[] }) => {
      const trimmed = text.trim()
      if ((!trimmed && files.length === 0) || status === 'streaming') return

      const chatFiles: ChatFile[] = files.map((f) => ({
        url: f.url,
        mediaType: f.mediaType,
        filename: f.filename,
      }))

      const next: ChatMessage[] = [
        ...messages,
        { role: 'user', content: trimmed, files: chatFiles },
        { role: 'assistant', content: '' },
      ]
      setMessages(next)
      setStatus('streaming')
      window.agent.chat(next.slice(0, -1), documentContext, model)
    },
    [messages, status, documentContext, model]
  )

  return (
    <div className="relative flex h-full flex-col p-3 border-l overflow-hidden">
      {oauthStatus !== 'authenticated' && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 backdrop-blur-[2px] bg-background/60 rounded-sm">
          <p className="text-sm text-muted-foreground text-center px-4">
            Claude에 연결하면<br />채팅을 사용할 수 있어요
          </p>
          <Button size="sm" onClick={() => window.auth.oauthStart()}>
            Connect to Claude
          </Button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto space-y-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={msg.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
          >
            <div
              className={
                msg.role === 'user'
                  ? 'max-w-[85%] space-y-1.5'
                  : 'max-w-[95%] text-sm text-foreground'
              }
            >
              {msg.role === 'user' && msg.files && msg.files.length > 0 && (
                <div className="flex flex-wrap gap-1 justify-end">
                  {msg.files.map((f, fi) =>
                    f.mediaType.startsWith('image/') ? (
                      <img
                        key={fi}
                        src={f.url}
                        alt={f.filename ?? 'attachment'}
                        className="max-h-32 max-w-full rounded-lg object-cover"
                      />
                    ) : (
                      <div
                        key={fi}
                        className="rounded-lg bg-accent px-2 py-1 text-xs text-muted-foreground"
                      >
                        {f.mediaType === 'application/pdf' ? '📄' : f.mediaType.startsWith('text/') ? '📝' : '📎'}{' '}
                        {f.filename ?? 'file'}
                      </div>
                    )
                  )}
                </div>
              )}
              {msg.role === 'user' && msg.content && (
                <div className="rounded-2xl bg-accent px-3 py-2 text-sm">
                  {msg.content}
                </div>
              )}
              {msg.role === 'assistant' && (
                <div className="flex gap-2 items-start">
                  <div className="avatar-luma size-5 rounded-full flex-shrink-0 mt-0.5" />
                  {msg.content ? (
                    <div className="text-sm text-foreground leading-relaxed space-y-3 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{msg.content}</Markdown>
                    </div>
                  ) : status === 'streaming' ? (
                    <span className="text-muted-foreground animate-pulse">…</span>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <PromptInput onSubmit={handleSubmit} accept="image/*,application/pdf,text/plain,text/markdown,text/csv,.md,.txt,.csv" multiple>
        <AttachmentPreview />
        <PromptInputBody>
          <PromptInputTextarea placeholder="Ask anything..." className="pt-3" />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <EffortButton
              effort={effort}
              onClick={() => setEffort(prev => CHAT_EFFORTS[(CHAT_EFFORTS.indexOf(prev) + 1) % CHAT_EFFORTS.length])}
            />
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex items-center gap-1.5 rounded-sm px-1.5 py-1 font-sans text-xs text-muted-foreground transition-colors hover:text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
                {MODEL_LABELS[model]}
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="min-w-36">
                <DropdownMenuLabel className="text-xs text-muted-foreground">Model</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={model}
                  onValueChange={(v) => {
                    const next = v as AgentModelId
                    setModel(next)
                    window.agent.stopChat()
                    setMessages([])
                    setStatus('idle')
                  }}
                >
                  {(Object.keys(MODEL_LABELS) as AgentModelId[]).map((m) => (
                    <DropdownMenuRadioItem key={m} value={m}>
                      {MODEL_LABELS[m]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <PromptInputActionMenu>
              <PromptInputActionMenuTrigger />
              <PromptInputActionMenuContent>
                <PromptInputActionAddAttachments />
                <PromptInputActionAddScreenshot />
              </PromptInputActionMenuContent>
            </PromptInputActionMenu>
          </PromptInputTools>
          <PromptInputSubmit
            status={status === 'streaming' ? 'streaming' : undefined}
            onStop={() => {
              window.agent.stopChat()
              setStatus('idle')
            }}
          />
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}
