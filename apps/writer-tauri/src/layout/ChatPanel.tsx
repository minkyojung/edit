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
import { clearFrozenRange, getFrozenRange } from '@/editor/frozenSelectionPlugin'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { Streamdown } from 'streamdown'
import { Badge } from '@/components/ui/badge'
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
import { useConnectDialog } from '@/stores/connectDialog'
import { ThreadTabs } from '@/chat/ThreadTabs'
import { PromptInput, type PromptStatus } from '@/chat/PromptInput'
import {
  DEFAULT_CHAT_EFFORT,
  DEFAULT_CHAT_MODEL,
  type ChatTurn,
  type MessagePart,
  type ReasoningPart,
  type TextPart,
  type ToolPart,
} from '@/chat/types'

/** Parse a submitted prompt string for a leading slash invocation.
 * Matches `/<name>` optionally followed by whitespace + args. Returns
 * null when the text doesn't start with a valid command name — callers
 * fall back to a normal free-text turn. */
function parseSlashInvocation(text: string): { name: string; args: string } | null {
  const m = /^\/([a-z][a-z0-9-]*)(?:\s+(.*))?$/s.exec(text.trim())
  if (!m) return null
  return { name: m[1], args: (m[2] ?? '').trim() }
}

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
      // Errors live on a dedicated turn field, not in the parts timeline —
      // that keeps prompt history (`buildPrompt`) and Copy output clean, and
      // lets the renderer surface the failure with proper error chrome.
      commit(isError ? 'error' : 'stopped', null, errMsg, errCode)
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

      <div className="shrink-0 border-t border-border p-3 space-y-2">
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
      <InlineCard>
        <div className="px-3 py-2">{body}</div>
        <InlineCardFooter>
          <IconPlayerStopFilled size={12} stroke={0} className="opacity-70" />
          <span>Stopped</span>
          {durationLabel && <span className="opacity-70">· {durationLabel}</span>}
          {canCopy && <CopyButton text={turn.content} />}
          {canRegenerate && <RegenerateButton onClick={() => onRegenerate!(turn.id)} />}
        </InlineCardFooter>
      </InlineCard>
    )
  }

  if (isError) {
    // Errored turn: distinct red-tinted card. Anything that streamed before
    // the failure (text, tool calls, reasoning) stays in the body so the user
    // can see how far the model got. The error message + Retry sit in the
    // footer.
    const hasBody = (turn.parts && turn.parts.length > 0) || hasText || hasThinking
    const isAuthError = turn.errorCode === 'AUTH'
    return (
      <InlineCard tone="destructive">
        {hasBody && <div className="px-3 py-2">{body}</div>}
        <InlineCardFooter tone="destructive">
          <IconAlertTriangle size={12} className="shrink-0 opacity-80" />
          <span className="flex-1 min-w-0 truncate" title={turn.errorText ?? undefined}>
            {turn.errorText ?? "Couldn't complete response"}
          </span>
          {durationLabel && <span className="opacity-70 shrink-0">{durationLabel}</span>}
          {isAuthError && <ReconnectButton />}
          {onRegenerate && (
            <button
              type="button"
              onClick={() => onRegenerate(turn.id)}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-destructive transition-colors shrink-0 outline-none hover:bg-destructive/15 focus-visible:ring-2 focus-visible:ring-ring/40"
              title="Retry"
            >
              <IconRefresh size={11} />
              <span className="font-medium">Retry</span>
            </button>
          )}
        </InlineCardFooter>
      </InlineCard>
    )
  }

  return (
    <>
      {body}
      {(durationLabel || stopReasonLabel || canCopy || canRegenerate) && (
        <div className="mt-1 flex items-center gap-1.5 text-xs">
          {stopReasonLabel && (
            <span className="inline-flex items-center gap-1 text-warning">
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
      className="inline-flex items-center rounded p-0.5 text-muted-foreground/70 transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      {copied ? <IconCheck size={11} /> : <IconCopy size={11} />}
    </button>
  )
}

/** Reconnect button. Surfaced inside the destructive footer when a chat
 * turn fails with `errorCode === 'AUTH'` — clicking opens the Claude OAuth
 * dialog (same one the sidebar account menu uses) so the user can re-auth
 * without leaving the conversation. */
function ReconnectButton() {
  const setOpen = useConnectDialog((s) => s.setOpen)
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-destructive transition-colors shrink-0 outline-none hover:bg-destructive/15 focus-visible:ring-2 focus-visible:ring-ring/40"
      title="Reconnect to Claude"
    >
      <span className="font-medium">Reconnect</span>
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
      className="inline-flex items-center rounded p-0.5 text-muted-foreground/70 transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
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

/** Coerce whatever the SDK / fetch / our own code threw into a single
 * readable line. Recognises a small set of well-known codes from the
 * sidecar (NETWORK / IDLE_TIMEOUT / SIDECAR_DIED / AUTH / RATE_LIMIT) and
 * maps them to user-friendly copy; falls through to message cleanup for
 * everything else. */
/** Pull the leading `^([A-Z_]+):` classifier from an error so the renderer
 * can branch on it (e.g. show a Reconnect button only for AUTH). Returns
 * undefined for errors that don't carry one. */
function extractErrorCode(e: unknown): string | undefined {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.match(/^([A-Z_]+):/)?.[1]
}

function humanizeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const code = raw.match(/^([A-Z_]+):/)?.[1]
  switch (code) {
    case 'SIDECAR_DIED':
      return 'Backend service crashed and is restarting — please try again'
    case 'IDLE_TIMEOUT':
      return 'No response — check your network connection'
    case 'NETWORK':
      return 'Network error — check your connection'
    case 'AUTH':
      return 'Authentication failed — please sign in again'
    case 'RATE_LIMIT':
      return 'Rate limited — try again in a moment'
  }
  let msg = raw.replace(/^Error:\s*/i, '').trim()
  if (msg.length === 0) return 'Something went wrong'
  if (msg.length > 240) msg = msg.slice(0, 237) + '…'
  return msg
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

/** Shared container for the small inline cards that show inside an
 * assistant turn — tool calls, thinking, propose_change, plus the
 * stopped / error wrappers around the whole turn body. Single
 * border / radius / background pattern so the chat surface reads as
 * one family instead of seven near-identical custom divs. */
function InlineCard({
  tone = 'default',
  className,
  children,
}: {
  tone?: 'default' | 'destructive'
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border',
        tone === 'destructive'
          ? 'border-destructive/40 bg-destructive/5'
          : 'border-border bg-muted/30',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** Footer row for InlineCard — used by stopped / error wrappers. The
 * tone follows the parent card so destructive cards keep the red
 * gradient through to the action row. */
function InlineCardFooter({
  tone = 'default',
  className,
  children,
}: {
  tone?: 'default' | 'destructive'
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 border-t px-3 py-1.5 text-xs',
        tone === 'destructive'
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-border bg-muted/40 text-muted-foreground',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** Renders the small status indicator next to a tool's name. Maps each
 * tool state to a Badge variant so the chat surface picks up its
 * info / success / warning / destructive tones from the theme tokens
 * rather than hand-rolled tailwind utilities. */
function ToolStateBadge({ state }: { state: ToolPart['state'] }) {
  const meta: Record<
    ToolPart['state'],
    {
      icon: React.ReactNode
      label: string
      variant: React.ComponentProps<typeof Badge>['variant']
    }
  > = {
    'input-streaming': {
      icon: <IconLoader2 size={12} className="animate-spin" />,
      label: 'preparing',
      variant: 'secondary',
    },
    'input-available': {
      icon: <IconLoader2 size={12} className="animate-spin" />,
      label: 'running',
      variant: 'info',
    },
    'output-available': {
      icon: <IconCheck size={12} />,
      label: 'done',
      variant: 'success',
    },
    'output-error': {
      icon: <IconAlertTriangle size={12} />,
      label: 'error',
      variant: 'destructive',
    },
    'approval-requested': {
      icon: <IconAlertTriangle size={12} />,
      label: 'needs approval',
      variant: 'warning',
    },
  }
  const m = meta[state]
  return (
    <Badge variant={m.variant}>
      {m.icon}
      {m.label}
    </Badge>
  )
}

/** Tool invocation card. Mirrors the AI Elements `<Tool>` family — a
 * collapsible wrapper with a header (tool name + state badge) and a
 * content section showing input and (when available) output. */
function ToolPartView({ part }: { part: ToolPart }) {
  const [open, setOpen] = React.useState(false)
  return (
    <InlineCard className="my-1 text-xs">
      <details
        open={open}
        onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 select-none">
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
        <div className="space-y-2 px-3 pb-2 pt-1">
          <KeyValueBlock label="input" value={part.input} />
          {(part.state === 'output-available' || part.state === 'output-error') && (
            <KeyValueBlock
              label={part.state === 'output-error' ? 'error' : 'output'}
              value={part.errorText ?? part.output}
            />
          )}
        </div>
      </details>
    </InlineCard>
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
    <InlineCard className="my-1 text-xs">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <HeaderIcon size={12} className="shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground">{kindLabel}</span>
        <span className="ml-auto">
          <ToolStateBadge state={part.state} />
        </span>
      </div>
      {!ready ? (
        <div className="px-3 py-1.5 text-muted-foreground italic">preparing…</div>
      ) : (
        <div className="space-y-1.5 px-3 py-2">
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
            <div className="border-t border-border pt-1.5 mt-1.5 text-muted-foreground">
              {input.rationale}
            </div>
          )}
        </div>
      )}
    </InlineCard>
  )
}

function KeyValueBlock({ label, value }: { label: string; value: unknown }) {
  const text = formatValue(value)
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted-foreground">{label}</div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-background px-2 py-1.5 font-mono text-xs text-foreground/80">
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
    <InlineCard className="mb-2 text-xs">
      <details
        open={open}
        onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary className="flex cursor-pointer items-center gap-2 list-none px-3 py-1.5 text-muted-foreground select-none">
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
        <div className="px-3 pb-2 pt-1 whitespace-pre-wrap text-muted-foreground/90">
          {content}
        </div>
      </details>
    </InlineCard>
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
