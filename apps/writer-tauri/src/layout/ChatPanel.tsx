// Conversation surface on the right.
//
// Per-proposal accept/reject lives in MarkPopover (anchored to the inline
// mark in the editor body). This panel is now a lightweight transcript:
// "Run Review" sends a user message, the resulting summary lands as an
// assistant message, and the user is directed back to the body to act on
// individual highlights.

import { useEffect, useRef, useState } from 'react'
import type { EditorView } from '@milkdown/kit/prose/view'
import * as Y from 'yjs'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { useClaudeAuth } from '@/hooks/useClaudeAuth'
import { runReview } from '@/agent/runReview'

type ChatRole = 'user' | 'assistant'

interface ChatMessage {
  role: ChatRole
  content: string
}

interface Props {
  editorView: EditorView | null
  ydoc: Y.Doc | null
}

export function ChatPanel({ editorView, ydoc }: Props) {
  const { account } = useClaudeAuth()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [running, setRunning] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, running])

  const ready = !!editorView && !!ydoc

  async function handleReview() {
    if (!ready || running) return
    setMessages((prev) => [...prev, { role: 'user', content: 'Run review on this document.' }])
    setRunning(true)
    try {
      const result = await runReview(editorView!, ydoc!)
      const summary =
        result.proposed === 0
          ? 'No issues to flag — looks clean to me.'
          : `Found **${result.applied.length}** issue${result.applied.length === 1 ? '' : 's'} — click any highlight in the document to review.`
      setMessages((prev) => [...prev, { role: 'assistant', content: summary }])
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `**Review failed.** ${String(e)}` },
      ])
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="relative flex h-full flex-col border-l border-border bg-background">
      {!account.connected && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 backdrop-blur-[2px] bg-background/60">
          <p className="text-sm text-muted-foreground text-center px-4">
            Claude에 연결하면<br />채팅을 사용할 수 있어요
          </p>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3 space-y-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {messages.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-8">
            리뷰를 실행하면 결과가 여기에 나타나요
          </p>
        )}
        {messages.map((msg, i) => (
          <MessageRow key={i} message={msg} />
        ))}
        {running && (
          <span className="block text-sm text-muted-foreground animate-pulse">검토 중…</span>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-border p-3">
        <Button
          className="w-full"
          disabled={!ready || running || !account.connected}
          onClick={handleReview}
        >
          {running ? 'Reviewing…' : 'Run Review'}
        </Button>
      </div>
    </div>
  )
}

const markdownComponents: React.ComponentProps<typeof Markdown>['components'] = {
  p: ({ children }) => <p className="leading-relaxed">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ children }) => (
    <code className="bg-muted text-foreground text-xs rounded px-1 py-0.5 font-mono">{children}</code>
  ),
}

function MessageRow({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-accent px-3 py-2 text-sm">{message.content}</div>
      </div>
    )
  }
  return (
    <div className="text-sm text-foreground leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {message.content}
      </Markdown>
    </div>
  )
}
