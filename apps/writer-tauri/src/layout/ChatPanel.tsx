// Conversation surface on the right.
//
// Per-document, multi-thread (max 5 active). Each thread persists as a
// Y.Array on the document's Y.Doc, so thread + turn state survives
// reloads and syncs across devices.
//
// Per-proposal accept/reject lives in MarkPopover (anchored to the inline
// mark in the editor body). This panel is the transcript surface only:
// "Run Review" appends a user/assistant pair to the active thread, and
// the user is directed back to the body to act on individual highlights.

import React, { useEffect, useRef, useState } from 'react'
import { IconPlayerStopFilled } from '@tabler/icons-react'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { useClaudeAuth } from '@/hooks/useClaudeAuth'
import { useThreads } from '@/hooks/useThreads'
import { useThreadTurns } from '@/hooks/useThreadTurns'
import { useActiveThread } from '@/hooks/useActiveThread'
import { runReview } from '@/agent/runReview'
import { runChat } from '@/agent/chat'
import { ThreadTabs } from '@/chat/ThreadTabs'
import { PromptInput, type PromptStatus } from '@/chat/PromptInput'
import type { ChatTurn } from '@/chat/types'

interface Props {
  editorView: EditorView | null
  ydoc: Y.Doc | null
  provider: HocuspocusProvider | null
  slug: string | null
}

export function ChatPanel({ editorView, ydoc, provider, slug }: Props) {
  const { account } = useClaudeAuth()
  const threads = useThreads(ydoc)
  const { activeId, setActiveId } = useActiveThread(slug, threads.active)
  const turnsHook = useThreadTurns(ydoc, activeId)
  const bottomRef = useRef<HTMLDivElement>(null)
  const runningRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const [chatStatus, setChatStatus] = useState<PromptStatus>('idle')

  // Track Hocuspocus initial sync so we don't auto-create a thread before the
  // server has had a chance to send us the existing list — that race produces
  // duplicate threads on every reload.
  const [synced, setSynced] = useState(false)
  useEffect(() => {
    setSynced(false)
    if (!provider) return
    if (provider.synced) {
      setSynced(true)
      return
    }
    const onSynced = () => setSynced(true)
    provider.on('synced', onSynced)
    return () => {
      provider.off('synced', onSynced)
    }
  }, [provider])

  // Auto-create the first thread only after we've synced — and only if the
  // document genuinely has none.
  useEffect(() => {
    if (!synced || !threads.ready) return
    if (threads.threads.length === 0) {
      threads.createThread()
    }
  }, [synced, threads])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [turnsHook.turns])

  const ready = !!editorView && !!ydoc && !!activeId

  async function handleSend(text: string) {
    if (!ready || chatStatus === 'streaming') return

    const userTurn: ChatTurn = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      ts: Date.now(),
    }
    const assistantId = crypto.randomUUID()
    const historyForModel = [...turnsHook.turns, userTurn]

    turnsHook.appendTurn(userTurn)
    turnsHook.appendTurn({
      id: assistantId,
      role: 'assistant',
      content: '',
      ts: Date.now(),
      status: 'streaming',
    })

    setChatStatus('streaming')
    const controller = new AbortController()
    abortRef.current = controller

    let acc = ''
    let thinkingAcc = ''
    try {
      await runChat({
        view: editorView!,
        ydoc: ydoc!,
        history: historyForModel,
        signal: controller.signal,
        onTextDelta: (delta) => {
          acc += delta
          turnsHook.updateTurn(assistantId, { content: acc })
        },
        onThinkingDelta: (delta) => {
          thinkingAcc += delta
          turnsHook.updateTurn(assistantId, { thinking: thinkingAcc })
        },
      })
      turnsHook.updateTurn(assistantId, {
        content: acc,
        thinking: thinkingAcc || undefined,
        status: 'done',
      })
      setChatStatus('idle')
    } catch (e) {
      const aborted = controller.signal.aborted
      turnsHook.updateTurn(assistantId, {
        content: acc + (aborted ? '' : `\n\n_Error: ${String(e)}_`),
        thinking: thinkingAcc || undefined,
        status: aborted ? 'stopped' : 'error',
      })
      setChatStatus(aborted ? 'idle' : 'error')
    } finally {
      abortRef.current = null
    }
  }

  function handleStop() {
    abortRef.current?.abort()
  }

  async function handleReview() {
    if (!ready || runningRef.current) return
    runningRef.current = true

    const userTurn: ChatTurn = {
      id: crypto.randomUUID(),
      role: 'user',
      content: 'Run review on this document.',
      ts: Date.now(),
    }
    turnsHook.appendTurn(userTurn)

    try {
      const result = await runReview(editorView!, ydoc!)
      const summary =
        result.proposed === 0
          ? 'No issues to flag — looks clean to me.'
          : `Found **${result.applied.length}** issue${result.applied.length === 1 ? '' : 's'} — click any highlight in the document to review.`
      turnsHook.appendTurn({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: summary,
        ts: Date.now(),
      })
    } catch (e) {
      turnsHook.appendTurn({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `**Review failed.** ${String(e)}`,
        ts: Date.now(),
      })
    } finally {
      runningRef.current = false
    }
  }

  return (
    <div className="relative flex h-full flex-col border-l border-border bg-background">
      {!account.connected && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 backdrop-blur-[2px] bg-background/60">
          <p className="text-sm text-muted-foreground text-center px-4">
            Connect to Claude<br />to start chatting
          </p>
        </div>
      )}

      <ThreadTabs
        active={threads.active}
        archived={threads.archived}
        activeId={activeId}
        onSelect={setActiveId}
        onCreate={() => {
          const id = threads.createThread()
          if (id) setActiveId(id)
        }}
        onArchive={(id) => {
          threads.archiveThread(id)
          // Active thread reconciles in useActiveThread when active list shifts.
        }}
        onRename={threads.renameThread}
        onRestore={(id) => {
          const r = threads.restoreThread(id)
          if (r.ok) setActiveId(id)
          return r
        }}
        onRestoreLimitReached={() => {
          // TODO: replace with a real toast once we add a toaster.
          console.warn('[threads] cannot restore — active limit reached')
        }}
      />

      <div className="flex-1 overflow-y-auto p-3 space-y-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {turnsHook.turns.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-8">
            Ask anything about this document
          </p>
        )}
        {turnsHook.turns.map((turn) => (
          <MessageRow key={turn.id} turn={turn} />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-border p-3 space-y-2">
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          disabled={!ready || !account.connected}
          onClick={handleReview}
        >
          Run Review
        </Button>
        <PromptInput
          status={chatStatus}
          disabled={!ready || !account.connected}
          onSubmit={handleSend}
          onStop={handleStop}
        />
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

function MessageRow({ turn }: { turn: ChatTurn }) {
  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-accent px-3 py-2 text-sm">{turn.content}</div>
      </div>
    )
  }
  const hasThinking = !!turn.thinking && turn.thinking.trim().length > 0
  const hasText = turn.content.trim().length > 0
  const isStreaming = turn.status === 'streaming'
  const isStopped = turn.status === 'stopped'

  const body = (
    <div className="text-sm text-foreground leading-relaxed">
      {hasThinking && (
        <ThinkingPanel content={turn.thinking!} streamingNoText={isStreaming && !hasText} />
      )}
      {!hasThinking && isStreaming && !hasText && <ThinkingSpinner label="Thinking..." />}
      {hasText && (
        <div className="leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {turn.content}
          </Markdown>
        </div>
      )}
    </div>
  )

  if (isStopped) {
    return (
      <div className="rounded-md border border-border/60 bg-muted/20 overflow-hidden">
        <div className="px-3 py-2">{body}</div>
        <div className="border-t border-border/60 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground flex items-center gap-1.5">
          <IconPlayerStopFilled size={12} stroke={0} className="opacity-70" />
          <span>Stopped</span>
        </div>
      </div>
    )
  }

  return body
}

function ThinkingSpinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
      <span>{label}</span>
    </div>
  )
}

function ThinkingPanel({
  content,
  streamingNoText,
}: {
  content: string
  streamingNoText: boolean
}) {
  // While the model is mid-stream and hasn't produced any text yet, render an
  // open spinner-style panel so the user can see the chain of thought live.
  // Once text starts flowing (or the turn finished), collapse to a small
  // toggleable capsule so it doesn't dominate the conversation.
  const [open, setOpen] = React.useState(streamingNoText)

  React.useEffect(() => {
    if (streamingNoText) setOpen(true)
    else setOpen(false)
  }, [streamingNoText])

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      className="mb-2 rounded-md border border-border/60 bg-muted/30 text-xs"
    >
      <summary className="flex cursor-pointer items-center gap-2 list-none px-2 py-1 text-muted-foreground select-none">
        {streamingNoText ? (
          <span className="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
        ) : (
          <span className="inline-block transition-transform" style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>
            ▸
          </span>
        )}
        <span>{streamingNoText ? 'Thinking…' : 'Thoughts'}</span>
      </summary>
      <div className="px-2 pb-2 pt-1 whitespace-pre-wrap text-muted-foreground/90">
        {content}
      </div>
    </details>
  )
}
