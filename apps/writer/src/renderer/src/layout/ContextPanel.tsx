import React, { useEffect, useRef, useState, useCallback } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { FileUIPart } from 'ai'
import { XIcon } from 'lucide-react'
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
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from '@/components/ui/prompt-input'
import { Button } from '@/components/ui/button'

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
            <XIcon className="size-2.5" />
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
                    <div className="prose prose-sm max-w-none
                      [&>*:first-child]:mt-0 [&>*:last-child]:mb-0
                      prose-p:leading-relaxed prose-pre:bg-muted prose-pre:text-xs
                      prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-code:before:content-none prose-code:after:content-none">
                      <Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown>
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
          <PromptInputTextarea placeholder="Ask anything..." />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <PromptInputSelect
              value={model}
              onValueChange={(v) => {
                const next = v as AgentModelId
                setModel(next)
                window.agent.stopChat()
                setMessages([])
                setStatus('idle')
              }}
            >
              <PromptInputSelectTrigger className="h-7 text-sm [&>svg]:hidden px-1.5">
                <PromptInputSelectValue />
              </PromptInputSelectTrigger>
              <PromptInputSelectContent>
                <PromptInputSelectItem value="claude-haiku-4-5">Haiku 4.5</PromptInputSelectItem>
                <PromptInputSelectItem value="claude-sonnet-4-6">Sonnet 4.6</PromptInputSelectItem>
                <PromptInputSelectItem value="claude-opus-4-7">Opus 4.7</PromptInputSelectItem>
              </PromptInputSelectContent>
            </PromptInputSelect>
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
