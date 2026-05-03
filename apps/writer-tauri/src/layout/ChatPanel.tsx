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
import { generateThreadTitle } from '@/agent/generateThreadTitle'
import { useChatActivity } from '@/stores/chatActivity'
import { useChatRuns } from '@/stores/chatRuns'
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
  const [chatStatus, setChatStatus] = useState<PromptStatus>('idle')
  // Live streaming buffer — keeps the in-flight assistant turn out of Yjs so
  // every delta is a cheap React state update instead of a doc rewrite. The
  // committed turn lands in Yjs only on done / stopped / error. Tagged with
  // its owning threadId so a thread switch mid-stream doesn't bleed text into
  // the wrong conversation.
  const [streaming, setStreaming] = useState<{ threadId: string; turn: ChatTurn } | null>(null)
  const startActivity = useChatActivity((s) => s.start)
  const endActivity = useChatActivity((s) => s.end)

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
  }, [turnsHook.turns, streaming])

  const ready = !!editorView && !!ydoc && !!activeId

  // Merge the in-flight streaming turn (local) with the persisted turns (Yjs)
  // for rendering. Only show the streaming turn if it belongs to the thread
  // we're currently viewing — protects against thread-switch mid-stream.
  const renderedTurns =
    streaming && streaming.threadId === activeId
      ? [...turnsHook.turns, streaming.turn]
      : turnsHook.turns

  async function handleSend(text: string) {
    if (!ready || chatStatus === 'streaming') return
    const threadId = activeId
    if (!threadId) return

    const userTurn: ChatTurn = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      ts: Date.now(),
    }
    const assistantId = crypto.randomUUID()
    const historyForModel = [...turnsHook.turns, userTurn]

    // First user message in an untitled thread → kick off background title
    // generation. Fire-and-forget; the slug-style fallback stays in place
    // until (and unless) Haiku returns something.
    const isFirstTurn = turnsHook.turns.length === 0
    if (isFirstTurn && activeId) {
      const thread = threads.threads.find((t) => t.id === activeId)
      if (thread && thread.title.trim().length === 0) {
        const idAtSend = activeId
        void generateThreadTitle(text).then((title) => {
          if (title) threads.renameThread(idAtSend, title)
        })
      }
    }

    // The user's turn is finished text — push to Yjs once and let it sync.
    turnsHook.appendTurn(userTurn)

    // Seed the live assistant turn in local state. No Yjs op fires until the
    // turn settles, so streaming deltas don't trigger collab traffic or
    // whole-list re-renders.
    setStreaming({
      threadId,
      turn: {
        id: assistantId,
        role: 'assistant',
        content: '',
        ts: Date.now(),
        status: 'streaming',
      },
    })

    setChatStatus('streaming')
    startActivity()

    let acc = ''
    let thinkingAcc = ''
    const commit = (status: ChatTurn['status']) => {
      turnsHook.appendTurn({
        id: assistantId,
        role: 'assistant',
        content: acc,
        thinking: thinkingAcc || undefined,
        ts: Date.now(),
        status,
      })
      setStreaming(null)
    }

    try {
      await runChat({
        view: editorView!,
        ydoc: ydoc!,
        threadId,
        history: historyForModel,
        onTextDelta: (delta) => {
          acc += delta
          setStreaming((s) =>
            s && s.threadId === threadId
              ? { ...s, turn: { ...s.turn, content: acc } }
              : s,
          )
        },
        onThinkingDelta: (delta) => {
          thinkingAcc += delta
          setStreaming((s) =>
            s && s.threadId === threadId
              ? { ...s, turn: { ...s.turn, thinking: thinkingAcc } }
              : s,
          )
        },
      })
      commit('done')
      setChatStatus('idle')
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === 'AbortError'
      if (!aborted) acc = `${acc}\n\n_Error: ${String(e)}_`
      commit(aborted ? 'stopped' : 'error')
      setChatStatus(aborted ? 'idle' : 'error')
    } finally {
      endActivity()
    }
  }

  function handleStop() {
    if (activeId) useChatRuns.getState().abortByThread(activeId)
  }

  async function handleReview() {
    if (!ready || runningRef.current) return
    const threadId = activeId
    if (!threadId) return
    runningRef.current = true

    const userTurn: ChatTurn = {
      id: crypto.randomUUID(),
      role: 'user',
      content: 'Run review on this document.',
      ts: Date.now(),
    }
    const assistantId = crypto.randomUUID()
    turnsHook.appendTurn(userTurn)
    setStreaming({
      threadId,
      turn: {
        id: assistantId,
        role: 'assistant',
        content: '',
        ts: Date.now(),
        status: 'streaming',
      },
    })

    startActivity()
    let thinkingAcc = ''
    let finalContent = ''
    let finalStatus: ChatTurn['status'] = 'done'
    try {
      const result = await runReview({
        view: editorView!,
        ydoc: ydoc!,
        onThinkingDelta: (delta) => {
          thinkingAcc += delta
          setStreaming((s) =>
            s && s.threadId === threadId
              ? { ...s, turn: { ...s.turn, thinking: thinkingAcc } }
              : s,
          )
        },
      })
      finalContent =
        result.proposed === 0
          ? 'No issues to flag — looks clean to me.'
          : `Found **${result.applied.length}** issue${result.applied.length === 1 ? '' : 's'} — click any highlight in the document to review.`
    } catch (e) {
      finalContent = `**Review failed.** ${String(e)}`
      finalStatus = 'error'
    } finally {
      turnsHook.appendTurn({
        id: assistantId,
        role: 'assistant',
        content: finalContent,
        thinking: thinkingAcc || undefined,
        ts: Date.now(),
        status: finalStatus,
      })
      setStreaming(null)
      runningRef.current = false
      endActivity()
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
        {renderedTurns.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-8">
            Ask anything about this document
          </p>
        )}
        {renderedTurns.map((turn) => (
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

const MessageRow = React.memo(function MessageRow({ turn }: { turn: ChatTurn }) {
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
          {isStreaming ? (
            // Skip markdown parsing while tokens are still arriving — re-running
            // the full remark pipeline on every delta scales O(n²) and dominates
            // the streaming render. Plain text with preserved whitespace looks
            // nearly identical mid-stream; the markdown render kicks in once on
            // 'done'.
            <div className="whitespace-pre-wrap">{turn.content}</div>
          ) : (
            <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {turn.content}
            </Markdown>
          )}
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
})

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
