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
import { Streamdown } from 'streamdown'
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
import type {
  ChatTurn,
  MessagePart,
  ReasoningPart,
  TextPart,
  ToolPart,
  UnknownPart,
} from '@/chat/types'

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
  const scrollRef = useRef<HTMLDivElement>(null)
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

  // Auto-scroll only when the user is already pinned to the bottom — if they
  // scrolled up to read history, leave them alone. Streaming uses 'auto' (no
  // animation) so rapid token deltas don't fight an in-flight smooth scroll.
  useEffect(() => {
    const c = scrollRef.current
    if (!c) return
    const distanceFromBottom = c.scrollHeight - c.scrollTop - c.clientHeight
    const pinned = distanceFromBottom < 80 // px
    if (!pinned) return
    bottomRef.current?.scrollIntoView({
      behavior: streaming ? 'auto' : 'smooth',
    })
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

    // Authoritative ordered list of parts for the in-flight assistant turn.
    // chat.ts emits an upsert per state change; we maintain this map (id →
    // part) plus a stable order array, then sync into streaming state behind
    // a 120ms throttle so multiple deltas land in one Streamdown commit.
    const partsById = new Map<string, MessagePart>()
    const partOrder: string[] = []
    const upsertPart = (part: MessagePart) => {
      if (!partsById.has(part.id)) partOrder.push(part.id)
      partsById.set(part.id, part)
    }
    const buildParts = (): MessagePart[] => partOrder.map((id) => partsById.get(id)!).filter(Boolean)
    // Derived (joined) text/reasoning kept for prompt history + legacy compat.
    const joinByType = (type: 'text' | 'reasoning'): string => {
      let out = ''
      for (const id of partOrder) {
        const p = partsById.get(id)
        if (p?.type === type) out += p.text
      }
      return out
    }

    let pendingFlush: number | null = null
    const scheduleFlush = () => {
      if (pendingFlush != null) return
      pendingFlush = window.setTimeout(() => {
        pendingFlush = null
        const parts = buildParts()
        const content = joinByType('text')
        const thinking = joinByType('reasoning')
        setStreaming((s) =>
          s && s.threadId === threadId
            ? {
                ...s,
                turn: { ...s.turn, content, thinking: thinking || undefined, parts },
              }
            : s,
        )
      }, 120)
    }

    const commit = (status: ChatTurn['status']) => {
      if (pendingFlush != null) {
        clearTimeout(pendingFlush)
        pendingFlush = null
      }
      const parts = buildParts()
      const content = joinByType('text')
      const thinking = joinByType('reasoning')
      turnsHook.appendTurn({
        id: assistantId,
        role: 'assistant',
        content,
        thinking: thinking || undefined,
        parts,
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
        onPart: (part) => {
          upsertPart(part)
          scheduleFlush()
        },
      })
      commit('done')
      setChatStatus('idle')
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === 'AbortError'
      if (!aborted) {
        // Surface the failure as an extra text part so the timeline still
        // tells the story even on error.
        const errPart: MessagePart = {
          id: crypto.randomUUID(),
          ts: Date.now(),
          type: 'text',
          text: `\n\n_Error: ${String(e)}_`,
        }
        upsertPart(errPart)
      }
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

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-3 space-y-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
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

// Streamdown renders raw markdown progressively (handles incomplete blocks
// during streaming) and memoizes per-block, so we don't need to gate
// markdown rendering on stream-vs-done. The component overrides below align
// inline element styling with the rest of the chat surface.
const markdownComponents: React.ComponentProps<typeof Streamdown>['components'] = {
  p: ({ children }) => <p className="leading-relaxed">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ children }) => (
    <code className="bg-muted text-foreground text-xs rounded px-1 py-0.5 font-mono">{children}</code>
  ),
}

// Streamdown's documented streaming pattern: pass content straight through,
// let it word-wrap each new chunk in animated spans, and rely on blur+opacity
// duration to mask token-arrival bursts (no client-side throttling needed).
// `isAnimating` toggles the animation rehype pass off entirely once the
// stream settles, so finished messages render with no leftover span markup.
const STREAM_ANIMATE = {
  animation: 'blurIn' as const,
  duration: 200,
  sep: 'word' as const,
}

function StreamingMarkdown({ content, isStreaming }: { content: string; isStreaming: boolean }) {
  return (
    <div className="leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <Streamdown
        animated={STREAM_ANIMATE}
        isAnimating={isStreaming}
        components={markdownComponents}
      >
        {content}
      </Streamdown>
    </div>
  )
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

  // "Has anything the user can actually see been produced yet?" — drives
  // the Thinking spinner. Counts text/reasoning with content, or any tool
  // invocation. Skips invisible parts (unknown / step-start) so a stray
  // system-init event doesn't briefly suppress the spinner.
  const hasVisibleContent =
    turn.parts && turn.parts.length > 0
      ? turn.parts.some(
          (p) =>
            (p.type === 'text' && p.text.length > 0) ||
            (p.type === 'reasoning' && p.text.length > 0) ||
            p.type === 'tool',
        )
      : hasText || hasThinking
  const showSpinner = isStreaming && !hasVisibleContent

  // Two render paths:
  // - Legacy turns (no `parts`): keep the original text+thinking layout.
  // - Parts-aware turns: walk the timeline so tool calls / reasoning blocks
  //   appear inline at the moment they happened.
  const body = (
    <div className="text-sm text-foreground leading-relaxed">
      {turn.parts && turn.parts.length > 0 ? (
        <PartList parts={turn.parts} isStreaming={isStreaming} />
      ) : (
        <>
          {hasThinking && (
            <ThinkingPanel content={turn.thinking!} streamingNoText={isStreaming && !hasText} />
          )}
          {hasText && <StreamingMarkdown content={turn.content} isStreaming={isStreaming} />}
        </>
      )}
      {showSpinner && <ThinkingSpinner label="Thinking..." />}
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

/** Walks an assistant turn's timeline. Each part type maps to its own
 * sub-component; unknown types fall through to a debug pill so coverage
 * gaps stay visible during development. */
function PartList({ parts, isStreaming }: { parts: MessagePart[]; isStreaming: boolean }) {
  return (
    <>
      {parts.map((part) => {
        switch (part.type) {
          case 'text':
            return <TextPartView key={part.id} part={part} isStreaming={isStreaming} />
          case 'reasoning':
            return <ReasoningPartView key={part.id} part={part} isStreaming={isStreaming} />
          case 'tool':
            return <ToolPartView key={part.id} part={part} />
          case 'step-start':
            return <StepStartView key={part.id} />
          case 'unknown':
            return <UnknownPartView key={part.id} part={part} />
        }
      })}
    </>
  )
}

function TextPartView({ part, isStreaming }: { part: TextPart; isStreaming: boolean }) {
  if (!part.text) return null
  return <StreamingMarkdown content={part.text} isStreaming={isStreaming} />
}

function ReasoningPartView({ part, isStreaming }: { part: ReasoningPart; isStreaming: boolean }) {
  if (!part.text) {
    return isStreaming ? <ThinkingSpinner label="Thinking..." /> : null
  }
  // Auto-expand only while this is still the active reasoning during streaming.
  return <ThinkingPanel content={part.text} streamingNoText={isStreaming} />
}

/** Tool invocation card. Mirrors the AI Elements `<Tool>` family — a
 * collapsible wrapper with a header (tool name + state badge) and a
 * content section showing input and (when available) output. */
function ToolPartView({ part }: { part: ToolPart }) {
  const [open, setOpen] = React.useState(false)
  const stateLabel: Record<ToolPart['state'], string> = {
    'input-streaming': 'preparing input…',
    'input-available': 'running…',
    'output-available': 'done',
    'output-error': 'error',
    'approval-requested': 'awaiting approval',
  }
  const stateTone: Record<ToolPart['state'], string> = {
    'input-streaming': 'text-muted-foreground',
    'input-available': 'text-muted-foreground',
    'output-available': 'text-emerald-600 dark:text-emerald-400',
    'output-error': 'text-red-600 dark:text-red-400',
    'approval-requested': 'text-amber-600 dark:text-amber-400',
  }

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      className="my-1 rounded-md border border-border/60 bg-muted/30 text-xs"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1 select-none">
        <span className="inline-block transition-transform" style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>
          ▸
        </span>
        <span className="font-mono">{part.toolName}</span>
        <span className={`ml-auto ${stateTone[part.state]}`}>{stateLabel[part.state]}</span>
      </summary>
      <div className="space-y-2 px-2 pb-2 pt-1">
        <KeyValueBlock label="input" value={part.input} />
        {(part.state === 'output-available' || part.state === 'output-error') && (
          <KeyValueBlock
            label={part.state === 'output-error' ? 'error' : 'output'}
            value={part.errorText ?? part.output}
          />
        )}
      </div>
    </details>
  )
}

function StepStartView() {
  return <hr className="my-2 border-border/40" />
}

function UnknownPartView({ part }: { part: UnknownPart }) {
  // Debug-only catch-all. Hidden in prod so the chat surface stays clean;
  // visible in dev for spotting SDK message types we haven't modeled yet.
  if (!import.meta.env.DEV) return null
  const summary =
    typeof part.raw === 'object' && part.raw && 'type' in part.raw
      ? String((part.raw as { type?: unknown }).type)
      : 'unknown'
  return (
    <div className="my-1 inline-flex items-center gap-1 rounded-md bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground">
      <span>▽</span>
      <span className="font-mono">{summary}</span>
    </div>
  )
}

function KeyValueBlock({ label, value }: { label: string; value: unknown }) {
  const text = formatValue(value)
  return (
    <div>
      <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-background/60 px-2 py-1 font-mono text-[11px]">
        {text}
      </pre>
    </div>
  )
}

function formatValue(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
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
