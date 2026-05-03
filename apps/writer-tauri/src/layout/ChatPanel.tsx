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
import {
  IconPlayerStopFilled,
  IconChevronRight,
  IconCheck,
  IconAlertTriangle,
  IconLoader2,
  IconTool,
  IconPencil,
  IconMessageCircle,
  IconQuote,
  IconCopy,
  IconRefresh,
} from '@tabler/icons-react'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { Streamdown } from 'streamdown'
import { Button } from '@/components/ui/button'
import { useClaudeAuth } from '@/hooks/useClaudeAuth'
import { useThreads } from '@/hooks/useThreads'
import { useThreadTurns } from '@/hooks/useThreadTurns'
import { useActiveThread } from '@/hooks/useActiveThread'
import { runChat } from '@/agent/chat'
import { COPYEDITOR_PROMPT } from '@/agent/skills/copyeditor'
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
} from '@/chat/types'

// Tool registered as `propose_change` on the `writer-relay` MCP server in
// sidecar/src/server.mjs. The Agent SDK exposes MCP tools to the model — and
// reports them back in stream events — under the `mcp__<server>__<tool>`
// canonical id, so that's the value we match on for UI routing.
const PROPOSE_CHANGE_TOOL = 'mcp__writer-relay__propose_change'

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

  // Regenerate is only offered on the most-recent settled assistant turn —
  // rewriting an older one would orphan every later turn's context. Hidden
  // entirely while a turn is in flight.
  const regeneratableTurnId = (() => {
    if (chatStatus === 'streaming' || streaming) return null
    for (let i = turnsHook.turns.length - 1; i >= 0; i--) {
      if (turnsHook.turns[i].role === 'assistant') return turnsHook.turns[i].id
      // Stop at the first non-assistant from the end — only the trailing
      // assistant turn is regeneratable.
      return null
    }
    return null
  })()

  /** Drives a single assistant turn end-to-end: seed streaming buffer, run
   * runChat with the given history, commit on settle. Shared by handleSend
   * (which prepends a fresh user turn) and handleRegenerate (which deletes
   * the prior assistant turn and reuses the existing user message). */
  async function runAssistantTurn(threadId: string, history: ChatTurn[]) {
    const startedAt = Date.now()
    const assistantId = crypto.randomUUID()

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

    const commit = (status: ChatTurn['status'], stopReason: string | null) => {
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
        durationMs: Date.now() - startedAt,
        stopReason,
      })
      setStreaming(null)
    }

    try {
      const result = await runChat({
        view: editorView!,
        ydoc: ydoc!,
        threadId,
        history,
        onPart: (part) => {
          upsertPart(part)
          scheduleFlush()
        },
      })
      commit('done', result.stopReason)
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
      commit(aborted ? 'stopped' : 'error', null)
      setChatStatus(aborted ? 'idle' : 'error')
    } finally {
      endActivity()
    }
  }

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

    await runAssistantTurn(threadId, [...turnsHook.turns, userTurn])
  }

  /** Regenerate the assistant turn at `assistantTurnId` — removes it, then
   * re-runs the model against the history up to (and including) the user
   * message that prompted it. Only valid for the most recent assistant turn:
   * earlier rewrites would invalidate every later turn's context. */
  async function handleRegenerate(assistantTurnId: string) {
    if (!ready || chatStatus === 'streaming') return
    const threadId = activeId
    if (!threadId) return

    const turns = turnsHook.turns
    const idx = turns.findIndex((t) => t.id === assistantTurnId)
    if (idx < 0 || turns[idx].role !== 'assistant') return
    const history = turns.slice(0, idx)
    if (history.length === 0 || history[history.length - 1].role !== 'user') return

    turnsHook.removeTurn(assistantTurnId)
    await runAssistantTurn(threadId, history)
  }

  function handleStop() {
    if (activeId) useChatRuns.getState().abortByThread(activeId)
  }

  async function handleReview() {
    if (!ready || runningRef.current || chatStatus === 'streaming') return
    const threadId = activeId
    if (!threadId) return
    runningRef.current = true

    const startedAt = Date.now()
    const userTurn: ChatTurn = {
      id: crypto.randomUUID(),
      role: 'user',
      content: 'Run review on this document.',
      ts: startedAt,
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

    setChatStatus('streaming')
    startActivity()

    // Same parts-timeline machinery as handleSend, just with a different
    // system prompt + model. Sharing this path means review automatically
    // gets token streaming, the ActivityStatus indicator, and the propose
    // change card UI.
    const partsById = new Map<string, MessagePart>()
    const partOrder: string[] = []
    const upsertPart = (part: MessagePart) => {
      if (!partsById.has(part.id)) partOrder.push(part.id)
      partsById.set(part.id, part)
    }
    const buildParts = (): MessagePart[] => partOrder.map((id) => partsById.get(id)!).filter(Boolean)
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

    let appliedCount = 0
    let proposedCount = 0

    const commit = (
      status: ChatTurn['status'],
      summary: string | null,
      stopReason: string | null,
    ) => {
      if (pendingFlush != null) {
        clearTimeout(pendingFlush)
        pendingFlush = null
      }
      const parts = buildParts()
      const modelText = joinByType('text')
      const thinking = joinByType('reasoning')
      const content = summary ?? modelText
      turnsHook.appendTurn({
        id: assistantId,
        role: 'assistant',
        content,
        thinking: thinking || undefined,
        parts,
        ts: Date.now(),
        status,
        durationMs: Date.now() - startedAt,
        stopReason,
      })
      setStreaming(null)
    }

    try {
      const result = await runChat({
        view: editorView!,
        ydoc: ydoc!,
        threadId,
        prompt: 'Begin your review.',
        systemPrompt: COPYEDITOR_PROMPT,
        model: 'claude-haiku-4-5',
        onPart: (part) => {
          upsertPart(part)
          scheduleFlush()
        },
        onToolApplied: (call) => {
          if (call.name !== 'propose_change') return
          proposedCount += 1
          if (call.result.ok) appliedCount += 1
        },
      })
      const summary =
        proposedCount === 0
          ? 'No issues to flag — looks clean to me.'
          : `Found **${appliedCount}** issue${appliedCount === 1 ? '' : 's'} — click any highlight in the document to review.`
      commit('done', summary, result.stopReason)
      setChatStatus('idle')
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === 'AbortError'
      const summary = aborted ? null : `**Review failed.** ${String(e)}`
      commit(aborted ? 'stopped' : 'error', summary, null)
      setChatStatus(aborted ? 'idle' : 'error')
    } finally {
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
          <MessageRow
            key={turn.id}
            turn={turn}
            onRegenerate={turn.id === regeneratableTurnId ? handleRegenerate : undefined}
          />
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

const MessageRow = React.memo(function MessageRow({
  turn,
  onRegenerate,
}: {
  turn: ChatTurn
  /** Provided only when this turn is the latest settled assistant turn —
   * the only one Regenerate is allowed on. */
  onRegenerate?: (turnId: string) => void
}) {
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

  // The activity line stays up until the user-facing text answer starts —
  // its label changes (Thinking… → Suggesting an edit… → …) as tools fire,
  // but it always sits in the same slot. We suppress it when the only
  // active label would be "Thinking…" AND the reasoning panel is already
  // visible (which has its own Thinking… spinner) — otherwise the user
  // sees two identical indicators stacked.
  const hasTextAnswer = turn.parts
    ? turn.parts.some((p) => p.type === 'text' && p.text.length > 0)
    : hasText
  const reasoningVisible =
    turn.parts?.some((p) => p.type === 'reasoning' && p.text.length > 0) ?? false
  const activityCurrentLabel = activityLabel(turn.parts)
  const showActivity =
    isStreaming &&
    !hasTextAnswer &&
    !(reasoningVisible && activityCurrentLabel === 'Thinking…')

  // Two render paths:
  // - Legacy turns (no `parts`): keep the original text+thinking layout.
  // - Parts-aware turns: walk the timeline so tool calls / reasoning blocks
  //   appear inline at the moment they happened.
  const body = (
    <div className="text-sm text-foreground leading-relaxed">
      {showActivity && <ActivityStatus parts={turn.parts} />}
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
    </div>
  )

  // Duration footer — wall-clock time the user waited. Only shown after the
  // turn settled (avoid a live ticker that fights the streaming animation).
  const durationLabel =
    !isStreaming && typeof turn.durationMs === 'number' ? formatDuration(turn.durationMs) : null
  // Abnormal stop reasons get surfaced explicitly so the user knows when an
  // answer was cut off, paused, or refused — `end_turn` / `stop_sequence` /
  // `tool_use` are routine and stay hidden.
  const stopReasonLabel = !isStreaming ? describeStopReason(turn.stopReason) : null

  // Copy is offered once the turn has produced final text and is no longer
  // streaming — copying mid-stream would clip the answer.
  const canCopy = !isStreaming && hasText
  const canRegenerate = !isStreaming && !!onRegenerate

  if (isStopped) {
    return (
      <div className="rounded-md border border-border/60 bg-muted/20 overflow-hidden">
        <div className="px-3 py-2">{body}</div>
        <div className="border-t border-border/60 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground flex items-center gap-1.5">
          <IconPlayerStopFilled size={12} stroke={0} className="opacity-70" />
          <span>Stopped</span>
          {durationLabel && <span className="opacity-70">· {durationLabel}</span>}
          {canCopy && <CopyButton text={turn.content} />}
          {canRegenerate && <RegenerateButton onClick={() => onRegenerate!(turn.id)} />}
        </div>
      </div>
    )
  }

  return (
    <>
      {body}
      {(durationLabel || stopReasonLabel || canCopy || canRegenerate) && (
        <div className="mt-1 flex items-center gap-1.5 text-[10px]">
          {stopReasonLabel && (
            <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
              <IconAlertTriangle size={10} />
              <span>{stopReasonLabel}</span>
            </span>
          )}
          {durationLabel && (
            <span className="text-muted-foreground/70">
              {stopReasonLabel ? `· ${durationLabel}` : durationLabel}
            </span>
          )}
          {canCopy && <CopyButton text={turn.content} />}
          {canRegenerate && <RegenerateButton onClick={() => onRegenerate!(turn.id)} />}
        </div>
      )}
    </>
  )
})

/** Copy button. Writes the message text to the clipboard and flips to a
 * checkmark for ~1.5s as confirmation. Errors are swallowed silently —
 * Tauri's webview clipboard call is reliable enough that surfacing a
 * failure here would just be noise. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false)
  const timerRef = React.useRef<number | null>(null)

  React.useEffect(() => {
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current)
    }
  }, [])

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (timerRef.current != null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard denied or unavailable — leave UI unchanged.
    }
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? 'Copied' : 'Copy message'}
      title={copied ? 'Copied' : 'Copy'}
      className="inline-flex items-center rounded p-0.5 text-muted-foreground/70 hover:bg-muted hover:text-foreground transition-colors"
    >
      {copied ? <IconCheck size={11} /> : <IconCopy size={11} />}
    </button>
  )
}

/** Regenerate button. Replaces the assistant turn with a fresh run against
 * the same prior history. Shown only on the most-recent settled assistant
 * turn — see ChatPanel's `regeneratableTurnId` for why. */
function RegenerateButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Regenerate response"
      title="Regenerate"
      className="inline-flex items-center rounded p-0.5 text-muted-foreground/70 hover:bg-muted hover:text-foreground transition-colors"
    >
      <IconRefresh size={11} />
    </button>
  )
}

/** Human-readable wall-clock duration. Stays terse so it sits unobtrusively
 * under the message — sub-second is shown to one decimal, single-minute uses
 * a single integer minute, and longer waits split into m+s. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return sec === 0 ? `${min}m` : `${min}m ${sec}s`
}

/** Map an Anthropic stop_reason to a user-facing message. Returns null for
 * routine reasons (`end_turn`, `stop_sequence`, `tool_use`, missing) so the
 * footer stays clean — only abnormal stops surface here. */
function describeStopReason(reason: string | null | undefined): string | null {
  switch (reason) {
    case 'max_tokens':
      return 'Response cut off (token limit)'
    case 'pause_turn':
      return 'Paused'
    case 'refusal':
      return 'Refused'
    default:
      return null
  }
}

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
            // Built-in MCP tool: render with a domain-aware preview instead
            // of the generic JSON dump.
            if (part.toolName === PROPOSE_CHANGE_TOOL) {
              return <ProposeChangePartView key={part.id} part={part} />
            }
            return <ToolPartView key={part.id} part={part} />
          case 'step-start':
            return <StepStartView key={part.id} />
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
  // Empty-state spinner is owned by the top-level ActivityStatus now —
  // skip rendering until we actually have thoughts to show.
  if (!part.text) return null
  return <ThinkingPanel content={part.text} streamingNoText={isStreaming} />
}

/** Top-of-turn activity indicator. Reads the parts timeline to pick a
 * natural-language label for what the model is currently doing —
 * "Thinking…" → "Suggesting an edit…" → "Reading the document…" — so the
 * user gets a human description of progress instead of a generic spinner.
 * Lives in a stable slot; only the label text changes on re-render. */
function ActivityStatus({ parts }: { parts?: MessagePart[] }) {
  return (
    <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
      <IconLoader2 size={12} className="shrink-0 animate-spin" />
      <span className="transition-opacity duration-150">{activityLabel(parts)}</span>
    </div>
  )
}

/** Pick the most descriptive label for the currently-active step. We walk
 * parts from newest to oldest and return the first unfinished tool's label;
 * fall back to "Thinking…" when the model is in reasoning or just started. */
function activityLabel(parts: MessagePart[] | undefined): string {
  if (parts) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]
      if (p.type === 'tool' && (p.state === 'input-streaming' || p.state === 'input-available')) {
        return labelForTool(p)
      }
    }
  }
  return 'Thinking…'
}

function labelForTool(part: ToolPart): string {
  if (part.toolName === PROPOSE_CHANGE_TOOL) {
    const input = (part.input ?? {}) as { kind?: string }
    return input.kind === 'comment' ? 'Adding a comment…' : 'Suggesting an edit…'
  }
  // Friendly labels for the most common Claude built-in tools. Anything
  // we haven't named falls back to a generic "Using …" string.
  const map: Record<string, string> = {
    Read: 'Reading the document…',
    Edit: 'Editing the document…',
    Write: 'Writing…',
    Bash: 'Running a command…',
    Grep: 'Searching the document…',
    Glob: 'Looking up files…',
    WebSearch: 'Searching the web…',
    WebFetch: 'Fetching from the web…',
  }
  return map[part.toolName] ?? `Using ${part.toolName}…`
}

/** Renders the small status indicator next to a tool's name. Each state
 * gets its own icon + color so the user can scan progress without
 * reading the label. */
function ToolStateBadge({ state }: { state: ToolPart['state'] }) {
  const meta: Record<ToolPart['state'], { icon: React.ReactNode; label: string; tone: string }> = {
    'input-streaming': {
      icon: <IconLoader2 size={12} className="animate-spin" />,
      label: 'preparing',
      tone: 'text-muted-foreground',
    },
    'input-available': {
      icon: <IconLoader2 size={12} className="animate-spin" />,
      label: 'running',
      tone: 'text-blue-600 dark:text-blue-400',
    },
    'output-available': {
      icon: <IconCheck size={12} />,
      label: 'done',
      tone: 'text-emerald-600 dark:text-emerald-400',
    },
    'output-error': {
      icon: <IconAlertTriangle size={12} />,
      label: 'error',
      tone: 'text-red-600 dark:text-red-400',
    },
    'approval-requested': {
      icon: <IconAlertTriangle size={12} />,
      label: 'needs approval',
      tone: 'text-amber-600 dark:text-amber-400',
    },
  }
  const m = meta[state]
  return (
    <span className={`inline-flex items-center gap-1 ${m.tone}`}>
      {m.icon}
      <span>{m.label}</span>
    </span>
  )
}

/** Tool invocation card. Mirrors the AI Elements `<Tool>` family — a
 * collapsible wrapper with a header (tool name + state badge) and a
 * content section showing input and (when available) output. */
function ToolPartView({ part }: { part: ToolPart }) {
  const [open, setOpen] = React.useState(false)
  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      className="my-1 rounded-md border border-border/60 bg-muted/30 text-xs"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1 select-none">
        <IconChevronRight
          size={12}
          className="shrink-0 transition-transform"
          style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
        />
        <IconTool size={12} className="shrink-0 text-muted-foreground" />
        <span className="font-mono">{part.toolName}</span>
        <span className="ml-auto">
          <ToolStateBadge state={part.state} />
        </span>
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

/** Domain-aware card for the writer-relay `propose_change` tool. Pulls the
 * meaningful fields out of input (kind/quote/content/rationale) so the
 * user sees the suggestion at a glance rather than raw JSON. */
function ProposeChangePartView({ part }: { part: ToolPart }) {
  const input = (part.input ?? {}) as {
    kind?: 'suggestion' | 'comment'
    suggestionType?: 'insert' | 'delete' | 'replace'
    quote?: string
    content?: string
    text?: string
    rationale?: string
  }
  const isComment = input.kind === 'comment'
  const HeaderIcon = isComment ? IconMessageCircle : IconPencil
  const kindLabel = isComment ? 'Comment' : `Suggestion${input.suggestionType ? ` · ${input.suggestionType}` : ''}`
  // While input is still streaming the strings may be partial JSON; only
  // show the structured layout once we have the parsed object.
  const ready = part.state !== 'input-streaming'
  const replacement = input.content ?? input.text

  return (
    <div className="my-1 rounded-md border border-border/60 bg-muted/20 text-xs">
      <div className="flex items-center gap-2 border-b border-border/50 px-2 py-1">
        <HeaderIcon size={12} className="shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground">{kindLabel}</span>
        <span className="ml-auto">
          <ToolStateBadge state={part.state} />
        </span>
      </div>
      {!ready ? (
        <div className="px-2 py-1 text-muted-foreground italic">preparing…</div>
      ) : (
        <div className="space-y-1.5 px-2 py-1.5">
          {input.quote && (
            <div className="flex gap-1.5">
              <IconQuote size={11} className="mt-0.5 shrink-0 text-muted-foreground" />
              <span className="line-through text-muted-foreground/80">{input.quote}</span>
            </div>
          )}
          {!isComment && replacement && (
            <div className="pl-[18px] text-foreground">→ {replacement}</div>
          )}
          {isComment && replacement && <div className="pl-[18px] text-foreground">{replacement}</div>}
          {input.rationale && (
            <div className="border-t border-border/40 pt-1.5 mt-1.5 text-muted-foreground">
              {input.rationale}
            </div>
          )}
        </div>
      )}
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
          <IconLoader2 size={12} className="shrink-0 animate-spin" />
        ) : (
          <IconChevronRight
            size={12}
            className="shrink-0 transition-transform"
            style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
          />
        )}
        <span>{streamingNoText ? 'Thinking…' : 'Thoughts'}</span>
      </summary>
      <div className="px-2 pb-2 pt-1 whitespace-pre-wrap text-muted-foreground/90">
        {content}
      </div>
    </details>
  )
}
