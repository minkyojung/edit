import React, { useEffect, useRef, useState, useCallback } from 'react'
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from '@/components/ui/prompt-input'

interface Props {
  documentContext: string | null
}

export function ContextPanel({ documentContext }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [status, setStatus] = useState<'idle' | 'streaming'>('idle')
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
    ({ text }: { text: string }) => {
      const trimmed = text.trim()
      if (!trimmed || status === 'streaming') return

      const next: ChatMessage[] = [
        ...messages,
        { role: 'user', content: trimmed },
        { role: 'assistant', content: '' },
      ]
      setMessages(next)
      setStatus('streaming')
      window.agent.chat(
        next.slice(0, -1),
        documentContext
      )
    },
    [messages, status, documentContext]
  )

  return (
    <div className="flex h-full flex-col p-3 border-l">
      <div className="flex-1 overflow-y-auto space-y-4 pb-2">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={
              msg.role === 'user'
                ? 'flex justify-end'
                : 'flex justify-start'
            }
          >
            <div
              className={
                msg.role === 'user'
                  ? 'max-w-[85%] rounded-2xl bg-accent px-3 py-2 text-sm'
                  : 'max-w-[95%] text-sm text-foreground'
              }
            >
              {msg.content || (status === 'streaming' && msg.role === 'assistant' ? (
                <span className="text-muted-foreground animate-pulse">…</span>
              ) : null)}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <PromptInput onSubmit={handleSubmit}>
        <PromptInputBody>
          <PromptInputTextarea placeholder="Ask anything..." />
        </PromptInputBody>
        <PromptInputFooter>
          <div />
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
