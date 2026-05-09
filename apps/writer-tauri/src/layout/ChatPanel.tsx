// Conversation surface on the right.
//
// Per-document, multi-thread (max 5 active). Each thread persists as a
// Y.Array on the document's Y.Doc, so thread + turn state survives
// reloads and syncs across devices.
//
// Per-proposal accept/reject lives in MarkPopover (anchored to the inline
// mark in the editor body). This panel is the transcript surface only:
// `/review` runs the copyeditor pass and drops inline comment marks; the
// user is directed back to the body to act on individual highlights.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { IconChevronDown } from '@tabler/icons-react'
import type { EditorView } from '@milkdown/kit/prose/view'
import { clearFrozenRange, getFrozenRange } from '@/editor/frozenSelectionPlugin'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { cn } from '@/lib/utils'
import { useClaudeAuth } from '@/hooks/useClaudeAuth'
import { useMarks } from '@/hooks/useMarks'
import { useThreads } from '@/hooks/useThreads'
import { useThreadTurns } from '@/hooks/useThreadTurns'
import { useActiveThread } from '@/hooks/useActiveThread'
import { runChat } from '@/agent/chat'
import { generateThreadTitle } from '@/agent/generateThreadTitle'
import {
  CommandRenderError,
  getCommand,
  renderBody,
  resolveKind,
  type LoadedCommand,
} from '@/chat/commands'
import { useChatActivity } from '@/stores/chatActivity'
import { useChatRuns } from '@/stores/chatRuns'
import { ThreadTabs } from '@/chat/ThreadTabs'
import { PromptInput, type PromptStatus } from '@/chat/PromptInput'
import {
  DEFAULT_CHAT_EFFORT,
  DEFAULT_CHAT_MODEL,
  type ChatTurn,
  type MessagePart,
} from '@/chat/types'
import { formatDuration } from '@/chat/utils/formatDuration'
import {
  describeStopReason,
  extractErrorCode,
  humanizeError,
} from '@/chat/utils/errorMessage'
import { StreamingMarkdown } from '@/chat/ui/StreamingMarkdown'
import { ThinkingPanel } from '@/chat/parts/ReasoningPart'
import { PartList } from '@/chat/parts/PartList'
import { ActivityStatus, activityLabel } from '@/chat/parts/ActivityStatus'
import { ErrorCard } from '@/chat/messages/ErrorCard'
import { StoppedCard } from '@/chat/messages/StoppedCard'
import { MessageFooter } from '@/chat/messages/MessageFooter'

/** Parse a submitted prompt string for a leading slash invocation.
 * Matches `/<name>` optionally followed by whitespace + args. Returns
 * null when the text doesn't start with a valid command name — callers
 * fall back to a normal free-text turn. */
function parseSlashInvocation(text: string): { name: string; args: string } | null {
  const m = /^\/([a-z][a-z0-9-]*)(?:\s+(.*))?$/s.exec(text.trim())
  if (!m) return null
  return { name: m[1], args: (m[2] ?? '').trim() }
}

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
  // Synchronous send-in-flight latch. Flipping `chatStatus` to 'streaming'
  // only takes effect on the *next* render, so a fast double-Enter could
  // squeeze a second handleSend in before the React state caught up. The
  // ref flips immediately on the same tick, so the second call short-
  // circuits before any side effects (turn append, sidecar request).
  const sendInFlightRef = useRef(false)
  const [chatStatus, setChatStatus] = useState<PromptStatus>('idle')
  // Live streaming buffer — keeps the in-flight assistant turn out of Yjs so
  // every delta is a cheap React state update instead of a doc rewrite. The
  // committed turn lands in Yjs only on done / stopped / error. Tagged with
  // its owning threadId so a thread switch mid-stream doesn't bleed text into
  // the wrong conversation.
  const [streaming, setStreaming] = useState<{ threadId: string; turn: ChatTurn } | null>(null)
  // Whether the user is currently pinned to the bottom of the transcript.
  // Single source of truth shared by the auto-scroll effect (which only
  // chases new content while pinned) and the scroll-to-bottom button (which
  // only shows when *not* pinned). 80px threshold matches the pre-existing
  // auto-scroll behavior so the two never disagree.
  const [pinned, setPinned] = useState(true)
  const startActivity = useChatActivity((s) => s.start)
  const endActivity = useChatActivity((s) => s.end)

  const handleScroll = useCallback(() => {
    const c = scrollRef.current
    if (!c) return
    const distance = c.scrollHeight - c.scrollTop - c.clientHeight
    setPinned(distance < 80)
  }, [])

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
    if (!pinned) return
    bottomRef.current?.scrollIntoView({
      behavior: streaming ? 'auto' : 'smooth',
    })
  }, [turnsHook.turns, streaming, pinned])

  const ready = !!editorView && !!ydoc && !!activeId

  // Track whether the editor currently has *something* selectable for slash
  // commands — either a live non-empty selection or a frozen snapshot taken
  // when focus moved to the chat input. selectionchange fires on both
  // caret moves inside the editor and on focus transitions to the textarea
  // (the latter triggers blur → snapshot in frozenSelectionPlugin), so it
  // covers both sources without separate plumbing.
  // Mirror the editor's "what's attached?" state into React. We track
  // both a boolean (used by the validator to gate Send) and the full
  // selected text (used by the chip preview). selectionchange fires on
  // every caret move and on focus transitions to/from the textarea, so
  // it covers live selections and the blur-snapshot path together;
  // focusout/focusin add coverage for keyboard-driven focus shifts.
  const [selectionPreview, setSelectionPreview] = useState<string | null>(null)
  const hasSelection = selectionPreview !== null
  useEffect(() => {
    if (!editorView) {
      setSelectionPreview(null)
      return
    }
    const update = () => {
      const ev = editorView
      const sel = ev.state.selection
      if (!sel.empty) {
        setSelectionPreview(ev.state.doc.textBetween(sel.from, sel.to, '\n', '\n'))
        return
      }
      const frozen = getFrozenRange(ev)
      if (frozen) {
        setSelectionPreview(ev.state.doc.textBetween(frozen.from, frozen.to, '\n', '\n'))
        return
      }
      setSelectionPreview(null)
    }
    update()
    document.addEventListener('selectionchange', update)
    editorView.dom.addEventListener('focusout', update)
    editorView.dom.addEventListener('focusin', update)
    return () => {
      document.removeEventListener('selectionchange', update)
      editorView.dom.removeEventListener('focusout', update)
      editorView.dom.removeEventListener('focusin', update)
    }
  }, [editorView])

  // X-button on the chip detaches the selection from the run. Clears both
  // the frozen snapshot and any live PM selection so the chip disappears
  // immediately whether the editor has focus or not. Collapsing live
  // selection uses TextSelection.create at the current head — no caret
  // jump, just collapse-in-place.
  const handleClearSelection = useCallback(() => {
    if (!editorView) return
    clearFrozenRange(editorView)
    const sel = editorView.state.selection
    if (!sel.empty) {
      editorView.dispatch(
        editorView.state.tr.setSelection(
          TextSelection.create(editorView.state.doc, sel.head),
        ),
      )
    }
    // PM transactions don't fire DOM selectionchange, so the listener that
    // mirrors selection state into React doesn't run on its own here.
    // Push the cleared state directly.
    setSelectionPreview(null)
  }, [editorView])

  // Active thread's preferred model. Threads created before the model field
  // existed return undefined; fall back to the default in that case.
  const activeThread = threads.threads.find((t) => t.id === activeId)
  const activeThreadModel = activeThread?.model ?? DEFAULT_CHAT_MODEL
  const activeThreadEffort = activeThread?.effort ?? DEFAULT_CHAT_EFFORT

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

  /** Optional per-run overrides for slash commands. When provided, the
   * command's rendered body becomes the system prompt, and chat.ts skips
   * its automatic `--- DOCUMENT ---` append (the body owns substitution).
   * `prompt` overrides the history-derived user message — needed because
   * a slash submit is the user message, not a free-text question. */
  type RunOverrides = {
    systemPrompt: string
    prompt: string
    model?: string
    effort?: 'low' | 'medium' | 'high'
    relayTools: string[]
    /** Optional final-content override. Called once the run settles
     * successfully — receives counts of propose_change calls observed,
     * and its return value replaces the assistant turn's text content.
     * Used by /review to render "Found N issues" instead of whatever
     * stray text the model produced alongside its tool calls. */
    summarize?: (counts: { proposed: number; applied: number }) => string
  }

  /** Drives a single assistant turn end-to-end: seed streaming buffer, run
   * runChat with the given history, commit on settle. Shared by handleSend
   * (which prepends a fresh user turn) and handleRegenerate (which deletes
   * the prior assistant turn and reuses the existing user message). */
  async function runAssistantTurn(
    threadId: string,
    history: ChatTurn[],
    overrides?: RunOverrides,
  ) {
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

    // OS-level "offline" event: fires the moment the user disables Wi-Fi or
    // ethernet drops. We don't wait for the sidecar's 45s idle watchdog in
    // this case — abort immediately so the failure surfaces within a beat.
    // `offlineAborted` lets the catch distinguish this from a user-pressed
    // Stop (which should render as the muted "Stopped" card, not as an error).
    let offlineAborted = false
    const onOffline = () => {
      offlineAborted = true
      if (activeId) useChatRuns.getState().abortByThread(activeId)
    }
    window.addEventListener('offline', onOffline)

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

    // Counters used by `summarize` (review-comments). Only mutated when a
     // summarize callback is present; otherwise stay at zero and are unused.
    let proposedCount = 0
    let appliedCount = 0

    const commit = (
      status: ChatTurn['status'],
      stopReason: string | null,
      errorText: string | null = null,
      errorCode: string | undefined = undefined,
      resetsAt: number | undefined = undefined,
    ) => {
      if (pendingFlush != null) {
        clearTimeout(pendingFlush)
        pendingFlush = null
      }
      const parts = buildParts()
      const modelText = joinByType('text')
      const thinking = joinByType('reasoning')
      // Successful runs with a summarize hook get their text replaced. We
      // keep the original parts timeline intact so the user can still
      // inspect each propose_change card if curious — only the top-level
      // `content` (used as the rendered prose + Copy output + history)
      // becomes the summary line.
      const content =
        status === 'done' && overrides?.summarize
          ? overrides.summarize({ proposed: proposedCount, applied: appliedCount })
          : modelText
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
        errorText: errorText ?? undefined,
        errorCode,
        resetsAt,
      })
      setStreaming(null)
    }

    try {
      const result = await runChat({
        view: editorView!,
        ydoc: ydoc!,
        threadId,
        history,
        prompt: overrides?.prompt,
        systemPrompt: overrides?.systemPrompt,
        appendDocument: overrides ? false : undefined,
        relayTools: overrides?.relayTools,
        model: overrides?.model ?? activeThreadModel,
        effort: overrides?.effort ?? activeThreadEffort,
        onPart: (part) => {
          upsertPart(part)
          scheduleFlush()
        },
        onToolApplied: overrides?.summarize
          ? (call) => {
              if (call.name !== 'propose_change') return
              proposedCount += 1
              if (call.result.ok) appliedCount += 1
            }
          : undefined,
      })
      commit('done', result.stopReason)
      setChatStatus('idle')
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === 'AbortError'
      // An offline-triggered abort looks like AbortError too, but it should
      // render as a real error (with Retry) — not the muted "Stopped" card
      // that user-pressed Stop produces.
      const isError = !aborted || offlineAborted
      const errMsg = !aborted
        ? humanizeError(e)
        : offlineAborted
          ? 'Lost network connection'
          : null
      const errCode = !aborted
        ? extractErrorCode(e)
        : offlineAborted
          ? 'NETWORK'
          : undefined
      // RATE_LIMIT errors carry a `rateLimit.resetsAt` (ms epoch) attached
      // by `runChat` from the SDK's most recent rate_limit_event. The
      // error card uses it to drive a countdown and gate Retry.
      const rateLimit = (e as Error & { rateLimit?: { resetsAt?: number } })?.rateLimit
      const resetsAt = errCode === 'RATE_LIMIT' ? rateLimit?.resetsAt : undefined
      // Errors live on a dedicated turn field, not in the parts timeline —
      // that keeps prompt history (`buildPrompt`) and Copy output clean, and
      // lets the renderer surface the failure with proper error chrome.
      commit(isError ? 'error' : 'stopped', null, errMsg, errCode, resetsAt)
      setChatStatus(isError ? 'error' : 'idle')
    } finally {
      window.removeEventListener('offline', onOffline)
      endActivity()
    }
  }

  /** Renders a command body and kicks off a single assistant turn against
   * its system prompt. The user message in the transcript is the literal
   * `/<name> args` text — same as Claude Code, keeps intent visible. */
  async function executeCommand(
    threadId: string,
    cmd: LoadedCommand,
    args: string,
    userText: string,
  ) {
    const userTurn: ChatTurn = {
      id: crypto.randomUUID(),
      role: 'user',
      content: userText,
      ts: Date.now(),
    }
    turnsHook.appendTurn(userTurn)

    let systemPrompt: string
    try {
      const ev = editorView!
      const docText = ev.state.doc.textBetween(0, ev.state.doc.content.size, '\n', '\n')
      // Pull selection text from either the live selection or, if the user
      // has clicked into the chat input and collapsed it, the frozen range
      // snapshot left behind by frozenSelectionPlugin. render.ts still
      // throws CommandRenderError when scope is "selection" and both are
      // empty — we surface that as an inline error turn below.
      const sel = ev.state.selection
      let selection = ''
      if (!sel.empty) {
        selection = ev.state.doc.textBetween(sel.from, sel.to, '\n', '\n')
      } else {
        const frozen = getFrozenRange(ev)
        if (frozen) {
          selection = ev.state.doc.textBetween(frozen.from, frozen.to, '\n', '\n')
        }
      }
      systemPrompt = renderBody(cmd, { document: docText, selection, args })
    } catch (e) {
      const msg = e instanceof CommandRenderError ? e.message : String(e)
      appendInlineError(threadId, userText, msg, /* alreadyAppendedUser */ true)
      return
    }

    const kind = resolveKind(cmd.kind)
    const overrides: RunOverrides = {
      systemPrompt,
      // Need a non-empty user message — the SDK won't accept ''. Args go
      // straight through; otherwise a synthetic kickoff line.
      prompt: args.trim() || `Run /${cmd.name}.`,
      model: cmd.model,
      effort: cmd.effort,
      relayTools: kind.relayTools,
      // review-comments emits many tool calls and any chat text it
      // produces is incidental — replace the final content with a
      // human summary so the transcript stays terse.
      summarize:
        kind.id === 'review-comments'
          ? ({ applied }) =>
              applied === 0
                ? 'No issues to flag — looks clean to me.'
                : `Found **${applied}** issue${applied === 1 ? '' : 's'} — click any highlight in the document to review.`
          : undefined,
    }
    await runAssistantTurn(threadId, [...turnsHook.turns, userTurn], overrides)
  }

  /** Append a finished error turn without invoking the model. Used for
   * slash invocations that fail before the run starts (unknown name,
   * missing selection). `alreadyAppendedUser` skips re-adding the user
   * message when the caller already pushed it. */
  function appendInlineError(
    _threadId: string,
    userText: string,
    message: string,
    alreadyAppendedUser = false,
  ) {
    if (!alreadyAppendedUser) {
      turnsHook.appendTurn({
        id: crypto.randomUUID(),
        role: 'user',
        content: userText,
        ts: Date.now(),
      })
    }
    turnsHook.appendTurn({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      ts: Date.now(),
      status: 'error',
      errorText: message,
    })
  }

  async function handleSend(text: string) {
    if (!ready || chatStatus === 'streaming') return
    // Latch BEFORE any await / state set so a fast double-Enter can't
    // smuggle a duplicate request through while React is still committing
    // the streaming state.
    if (sendInFlightRef.current) return
    sendInFlightRef.current = true
    try {
      const threadId = activeId
      if (!threadId) return

      // Slash command? Route through executeCommand so the .md body becomes
      // the system prompt and any kind-specific tools are wired in.
      const slash = parseSlashInvocation(text)
      if (slash) {
        const cmd = getCommand(slash.name)
        if (!cmd) {
          appendInlineError(threadId, text, `Unknown command: /${slash.name}`)
          return
        }
        await executeCommand(threadId, cmd, slash.args, text)
        return
      }

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
    } finally {
      sendInFlightRef.current = false
    }
  }

  /** Regenerate the assistant turn at `assistantTurnId` — removes it, then
   * re-runs the model against the history up to (and including) the user
   * message that prompted it. Only valid for the most recent assistant turn:
   * earlier rewrites would invalidate every later turn's context. */
  async function handleRegenerate(assistantTurnId: string) {
    if (!ready || chatStatus === 'streaming') return
    if (sendInFlightRef.current) return
    sendInFlightRef.current = true
    try {
      const threadId = activeId
      if (!threadId) return

      const turns = turnsHook.turns
      const idx = turns.findIndex((t) => t.id === assistantTurnId)
      if (idx < 0 || turns[idx].role !== 'assistant') return
      const history = turns.slice(0, idx)
      if (history.length === 0 || history[history.length - 1].role !== 'user') return

      turnsHook.removeTurn(assistantTurnId)
      await runAssistantTurn(threadId, history)
    } finally {
      sendInFlightRef.current = false
    }
  }

  function handleStop() {
    if (activeId) useChatRuns.getState().abortByThread(activeId)
  }

  // Pre-submit validator: blocks unknown commands and selection-scoped
  // commands invoked without a selection. Free chat (no leading slash) is
  // always ok. The leading-slash branch returns ok while the user is still
  // typing the name (no space yet) so the palette — not a red error —
  // handles the in-progress state.
  const validatePrompt = useCallback(
    (text: string) => {
      const m = /^\/([a-z][a-z0-9-]*)(\s|$)/.exec(text)
      if (!m) return { ok: true as const }
      const hasSpace = m[2].length > 0
      const cmd = getCommand(m[1])
      if (!cmd) {
        return hasSpace
          ? { ok: false as const, message: `Unknown command: /${m[1]}` }
          : { ok: true as const }
      }
      if (cmd.scope === 'selection' && !hasSelection) {
        return {
          ok: false as const,
          message: `Select text in the editor to use /${cmd.name}.`,
        }
      }
      return { ok: true as const }
    },
    [hasSelection],
  )

  return (
    <div
      data-chat-panel
      className="relative flex h-full flex-col border-l border-border bg-background"
    >
      {!account.connected && (
        <div className="absolute inset-0 z-overlay flex flex-col items-center justify-center gap-3 backdrop-blur-[2px] bg-background/60">
          <p className="text-sm text-muted-foreground text-center px-4">
            Connect to Claude<br />to start chatting
          </p>
        </div>
      )}

      {/* Window-chrome row — mirrors EditorHeader so the two columns
          align at --header-h. Hosts the review-progress badge on the
          left; reserved for model / account / right-sidebar toggle on
          the right once those land. */}
      <div
        className="flex shrink-0 items-center gap-2 border-b border-border bg-background px-3"
        style={{ height: 'var(--header-h)' }}
      >
        <ReviewProgressBadge ydoc={ydoc} />
      </div>

      <div
        className="flex shrink-0 items-stretch bg-background px-2 shadow-[inset_0_-1px_0_var(--border)]"
        style={{ height: 'var(--header-h)' }}
      >
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
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto p-3 space-y-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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

      <div className="relative shrink-0 px-3 pb-3 space-y-2">
        <ScrollToBottomButton
          visible={!pinned && renderedTurns.length > 0}
          onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}
        />
        <PromptInput
          status={chatStatus}
          disabled={!ready || !account.connected}
          onSubmit={handleSend}
          onStop={handleStop}
          model={activeThreadModel}
          onModelChange={(m) => activeId && threads.setThreadModel(activeId, m)}
          effort={activeThreadEffort}
          onEffortChange={(e) => activeId && threads.setThreadEffort(activeId, e)}
          validate={validatePrompt}
          selectionText={selectionPreview}
          onClearSelection={handleClearSelection}
        />
      </div>
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
        <div className="max-w-[85%] rounded-3xl bg-accent px-3.5 py-2 text-sm">{turn.content}</div>
      </div>
    )
  }
  const hasThinking = !!turn.thinking && turn.thinking.trim().length > 0
  const hasText = turn.content.trim().length > 0
  const isStreaming = turn.status === 'streaming'
  const isStopped = turn.status === 'stopped'
  const isError = turn.status === 'error'

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
      <StoppedCard
        turn={turn}
        body={body}
        hasText={hasText}
        durationLabel={durationLabel}
        onRegenerate={onRegenerate}
      />
    )
  }

  if (isError) {
    return (
      <ErrorCard
        turn={turn}
        body={body}
        hasText={hasText}
        hasThinking={hasThinking}
        durationLabel={durationLabel}
        onRegenerate={onRegenerate}
      />
    )
  }

  return (
    <>
      {body}
      <MessageFooter
        turn={turn}
        durationLabel={durationLabel}
        stopReasonLabel={stopReasonLabel}
        canCopy={canCopy}
        canRegenerate={canRegenerate}
        onRegenerate={onRegenerate}
      />
    </>
  )
})

/** Floating "jump to latest" affordance. Sits inside the PromptInput's
 * wrapper as an absolute sibling — `bottom-full` anchors it to the wrapper's
 * top edge, so the button rides up naturally as the input grows. Visibility
 * is fully driven by the parent (`pinned` + non-empty transcript). */
function ScrollToBottomButton({
  visible,
  onClick,
}: {
  visible: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Scroll to latest"
      tabIndex={visible ? 0 : -1}
      className={cn(
        'absolute left-1/2 bottom-full z-10 mb-2 -translate-x-1/2',
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5',
        'border border-border/40 bg-muted text-xs font-medium text-muted-foreground shadow-sm',
        'transition-opacity duration-150',
        'hover:bg-accent hover:text-foreground',
        'outline-none focus-visible:ring-3 focus-visible:ring-ring/30',
        visible ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
    >
      <IconChevronDown size={14} stroke={2} />
      <span>Scroll to bottom</span>
    </button>
  )
}

/** Header-row badge: "Reviewing…" while the active doc has open
 *  marks. No counts — just a presence signal that there's pending
 *  AI feedback to act on. Disappears when all marks are resolved. */
function ReviewProgressBadge({ ydoc }: { ydoc: Y.Doc | null }) {
  const marks = useMarks(ydoc)
  if (Object.keys(marks).length === 0) return null
  return (
    <span className="text-xs text-muted-foreground">Reviewing…</span>
  )
}
