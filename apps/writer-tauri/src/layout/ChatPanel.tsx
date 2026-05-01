// M8.3 Phase 1 — minimal chat panel.
//
// Hosts the conversation with Claude on the right side. Currently the only
// way to send a message is the "Run Review" button, which kicks off the
// existing runReview flow and records both the user prompt and the
// resulting summary as chat messages. Free-form chat input + ProposalSnippet
// rendering arrive in later phases.

import { useEffect, useRef, useState } from 'react'
import type { EditorView } from '@milkdown/kit/prose/view'
import * as Y from 'yjs'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { useClaudeAuth } from '@/hooks/useClaudeAuth'
import { useMarks } from '@/hooks/useMarks'
import { runReview } from '@/agent/runReview'
import { acceptMark, jumpToMark, rejectMark } from '@/editor/markActions'
import { MARK_CLICKED_EVENT, type MarkClickedDetail } from '@/editor/markClickPlugin'
import { ProposalSnippet } from '@/components/agent/ProposalSnippet'
import type { ProposalCardStatus } from '@/components/agent/ProposalSnippet'
import type { Proposal } from '@/agent/proposals'

type ChatRole = 'user' | 'assistant'

interface AppliedProposal {
  markId: string
  proposal: Proposal
  by: string
}

interface ChatMessage {
  role: ChatRole
  content: string
  proposals?: AppliedProposal[]
}

interface Props {
  editorView: EditorView | null
  ydoc: Y.Doc | null
}

export function ChatPanel({ editorView, ydoc }: Props) {
  const { account } = useClaudeAuth()
  const marks = useMarks(ydoc)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [running, setRunning] = useState(false)
  const [resolutions, setResolutions] = useState<Record<string, 'accepted' | 'rejected'>>({})
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, running])

  // Listen for clicks on inline marks in the editor and scroll the matching
  // proposal snippet into view.
  useEffect(() => {
    function onMarkClicked(e: Event) {
      const ce = e as CustomEvent<MarkClickedDetail>
      const markId = ce.detail?.markId
      if (!markId) return
      const el = document.querySelector(`[data-snippet-mark-id="${markId}"]`)
      if (!el) return
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('snippet-flash')
      window.setTimeout(() => el.classList.remove('snippet-flash'), 1000)
    }
    window.addEventListener(MARK_CLICKED_EVENT, onMarkClicked)
    return () => window.removeEventListener(MARK_CLICKED_EVENT, onMarkClicked)
  }, [])

  const ready = !!editorView && !!ydoc

  async function handleReview() {
    if (!ready || running) return
    setMessages((prev) => [...prev, { role: 'user', content: 'Run review on this document.' }])
    setRunning(true)
    try {
      const result = await runReview(editorView!, ydoc!)
      const skippedNote = result.skipped.length
        ? ` · ${result.skipped.length} skipped`
        : ''
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content:
            result.proposed === 0
              ? 'No issues to flag — looks clean to me.'
              : `Found **${result.proposed}** issue${result.proposed > 1 ? 's' : ''}, applied **${result.applied.length}**${skippedNote}.`,
          proposals: result.applied,
        },
      ])
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
          <MessageRow
            key={i}
            message={msg}
            marks={marks}
            resolutions={resolutions}
            onAccept={(markId) => {
              if (!editorView || !ydoc) return
              acceptMark(editorView, ydoc, markId)
              setResolutions((prev) => ({ ...prev, [markId]: 'accepted' }))
            }}
            onReject={(markId) => {
              if (!editorView || !ydoc) return
              rejectMark(editorView, ydoc, markId)
              setResolutions((prev) => ({ ...prev, [markId]: 'rejected' }))
            }}
            onJump={(markId) => {
              if (!editorView) return
              jumpToMark(editorView, markId)
            }}
          />
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

interface MessageRowProps {
  message: ChatMessage
  marks: Record<string, unknown>
  resolutions: Record<string, 'accepted' | 'rejected'>
  onAccept: (markId: string) => void
  onReject: (markId: string) => void
  onJump: (markId: string) => void
}

function MessageRow({ message, marks, resolutions, onAccept, onReject, onJump }: MessageRowProps) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-accent px-3 py-2 text-sm">{message.content}</div>
      </div>
    )
  }

  function statusFor(markId: string): ProposalCardStatus {
    if (resolutions[markId]) return resolutions[markId]
    if (markId in marks) return 'pending'
    return 'rejected' // mark removed externally — treat as resolved
  }

  return (
    <div className="space-y-2">
      <div className="text-sm text-foreground leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
        <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {message.content}
        </Markdown>
      </div>
      {message.proposals && message.proposals.length > 0 && (
        <div className="space-y-2">
          {message.proposals.map((p) => (
            <ProposalSnippet
              key={p.markId}
              markId={p.markId}
              proposal={p.proposal}
              by={p.by}
              status={statusFor(p.markId)}
              onAccept={() => onAccept(p.markId)}
              onReject={() => onReject(p.markId)}
              onJump={() => onJump(p.markId)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
