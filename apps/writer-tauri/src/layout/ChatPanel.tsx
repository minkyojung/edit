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

import { useCallback, useEffect, useRef, useState } from 'react'
import type { EditorView } from '@milkdown/kit/prose/view'
import { IconMessageCircle, IconSparkles } from '@tabler/icons-react'
import { clearFrozenRange, getFrozenRange } from '@/editor/frozenSelectionPlugin'
import { TextSelection } from '@milkdown/kit/prose/state'
import * as Y from 'yjs'
import { Button } from '@/components/ui/button'
import { useClaudeAuth } from '@/hooks/useClaudeAuth'
import { useConnectDialog } from '@/stores/connectDialog'
import { useThreads } from '@/hooks/useThreads'
import { useThreadTurns } from '@/hooks/useThreadTurns'
import { useActiveThread } from '@/hooks/useActiveThread'
import { generateThreadTitle } from '@/agent/generateThreadTitle'
import {
  CommandRenderError,
  getCommand,
  renderBody,
  resolveKind,
  type LoadedCommand,
} from '@/chat/commands'
import { useChatRuns } from '@/stores/chatRuns'
import { ThreadPicker } from '@/chat/ThreadPicker'
import { PromptInput } from '@/chat/PromptInput'
import { PendingEditsBar } from '@/chat/PendingEditsBar'
import {
  DEFAULT_CHAT_EFFORT,
  DEFAULT_CHAT_MODEL,
  type ChatTurn,
} from '@/chat/types'
import { useChatRunner, type RunOverrides } from '@/chat/hooks/useChatRunner'
import { MessageRow } from '@/chat/messages/MessageRow'
import { ScrollToBottomButton } from '@/chat/ScrollToBottomButton'
import { notify } from '@/lib/notify'

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
  slug: string | null
}

export function ChatPanel({ editorView, ydoc, slug }: Props) {
  const { account } = useClaudeAuth()
  const setConnectOpen = useConnectDialog((s) => s.setOpen)
  const threads = useThreads(slug)
  const { activeId, setActiveId } = useActiveThread(slug, threads.active)
  const turnsHook = useThreadTurns(activeId)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Synchronous send-in-flight latch. Flipping `chatStatus` to 'streaming'
  // only takes effect on the *next* render, so a fast double-Enter could
  // squeeze a second handleSend in before the React state caught up. The
  // ref flips immediately on the same tick, so the second call short-
  // circuits before any side effects (turn append, sidecar request).
  const sendInFlightRef = useRef(false)
  // Whether the user is currently pinned to the bottom of the transcript.
  // Single source of truth shared by the auto-scroll effect (which only
  // chases new content while pinned) and the scroll-to-bottom button (which
  // only shows when *not* pinned). 80px threshold matches the pre-existing
  // auto-scroll behavior so the two never disagree.
  const [pinned, setPinned] = useState(true)

  // Active thread's preferred model / effort. Threads created before these
  // fields existed return undefined; fall back to the defaults in that case.
  const activeThread = threads.threads.find((t) => t.id === activeId)
  const activeThreadModel = activeThread?.model ?? DEFAULT_CHAT_MODEL
  const activeThreadEffort = activeThread?.effort ?? DEFAULT_CHAT_EFFORT

  // Single hook owns the streaming buffer state, the chat-level status, and
  // the run() dispatcher. Handlers below (handleSend / handleRegenerate /
  // executeCommand) just call `runner.run(...)` instead of duplicating the
  // run lifecycle.
  const runner = useChatRunner({
    editorView,
    ydoc,
    slug,
    activeId,
    activeThreadModel,
    activeThreadEffort,
    appendTurn: turnsHook.appendTurn,
    markSessionStarted: threads.markSessionStarted,
    sessionStarted: activeThread?.sessionStarted ?? false,
  })
  const { status: chatStatus, streaming } = runner

  const handleScroll = useCallback(() => {
    const c = scrollRef.current
    if (!c) return
    const distance = c.scrollHeight - c.scrollTop - c.clientHeight
    setPinned(distance < 80)
  }, [])

  // Auto-create the first thread once threads hydrate from the doc's
  // Y.Doc + IDB. threads.ready flips true after useThreads observes
  // the Y.Array — the single readiness signal we need now that the
  // doc is local-only (no server response to race against).
  useEffect(() => {
    if (!threads.ready) return
    if (threads.threads.length === 0) {
      void threads.createThread()
    }
  }, [threads])

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

  /** Renders a command body and kicks off a single assistant turn against
   * its system prompt. The user message in the transcript is the literal
   * `/<name> args` text — same as Claude Code, keeps intent visible. */
  /** Execute a slash command's run lifecycle for a user turn that's already
   * sitting in the thread. Renders the system prompt against the *current*
   * editor state (doc + selection) so a regenerate after a doc edit picks
   * up the latest text, builds the kind-specific RunOverrides, and dispatches
   * through the runner. Caller is responsible for putting `userTurn` into
   * `history` and turnsHook before calling. */
  async function runSlashCommand(
    threadId: string,
    cmd: LoadedCommand,
    args: string,
    userTurn: ChatTurn,
    history: ChatTurn[],
  ) {
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
      appendInlineError(threadId, userTurn.content, msg, /* alreadyAppendedUser */ true)
      return
    }

    const kind = resolveKind(cmd.kind)
    const overrides: RunOverrides = {
      systemPrompt,
      // Need a non-empty user message — the SDK won't accept ''. Args go
      // straight through when present. When absent, use a slash-free
      // kickoff line: the underlying Claude Agent SDK scans user
      // messages for `/<name>` patterns and routes them to its own
      // skill registry, which doesn't know our command names. A bare
      // `Run /${cmd.name}.` would be intercepted and rejected with
      // "skill not available" instead of falling through to the
      // system prompt we already set above.
      prompt: args.trim() || 'Begin.',
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
    await runner.run(threadId, history, overrides)
  }

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
      // Stamp so handleRegenerate can rerun this turn through the same
      // command path (system prompt + relayTools + summarize) instead of
      // replaying the literal "/proofread" text as plain chat.
      slashInvocation: { name: cmd.name, args },
    }
    turnsHook.appendTurn(userTurn)
    await runSlashCommand(threadId, cmd, args, userTurn, [...turnsHook.turns, userTurn])
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

      await runner.run(threadId, [...turnsHook.turns, userTurn])
    } finally {
      sendInFlightRef.current = false
    }
  }

  /** Regenerate the assistant turn at `assistantTurnId` — removes it, then
   * re-runs the model against the history up to (and including) the user
   * message that prompted it. Only valid for the most recent assistant turn:
   * earlier rewrites would invalidate every later turn's context.
   *
   * Slash-command turns (`slashInvocation` stamped on the user turn) route
   * back through runSlashCommand so the rerun gets the same system prompt,
   * relayTools, and summarize hook as the original — without that branch
   * the rerun would replay the literal `/proofread` text as plain chat. */
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

      const lastUser = history[history.length - 1]
      // Pre-Phase-3.B: regenerate cleaned up the prior run's marks
      // via `cleanupMark` so a re-`/proofread` wouldn't layer stale
      // marks under the new ones. With propose_change gone (3.B) the
      // turn no longer leaves marks behind, so the cleanup loop is
      // unnecessary — just remove the assistant turn and rerun.
      turnsHook.removeTurn(assistantTurnId)

      if (lastUser.slashInvocation) {
        const cmd = getCommand(lastUser.slashInvocation.name)
        if (cmd) {
          await runSlashCommand(
            threadId,
            cmd,
            lastUser.slashInvocation.args,
            lastUser,
            history,
          )
          return
        }
        // Command was renamed / removed since the original send; fall back
        // to plain chat so the rerun at least produces something.
      }
      await runner.run(threadId, history)
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
        // Disconnected overlay — ContentUnavailableView pattern with an
        // explicit Connect CTA. The button reuses the same global
        // ConnectClaudeDialog store the sidebar Avatar menu does, so
        // there's one dialog in the app and one OAuth flow no matter
        // which entry point opens it.
        <div className="absolute inset-0 z-overlay flex flex-col items-center justify-center gap-2 bg-background/70 px-6 backdrop-blur-[2px]">
          <IconSparkles
            size={48}
            stroke={1.5}
            className="text-muted-foreground/40"
          />
          <p className="text-[16px] font-semibold text-foreground">
            Connect Claude
          </p>
          <p className="max-w-xs text-center text-[14px] text-muted-foreground">
            Sign in with your Anthropic account to start chatting.
          </p>
          <Button
            variant="default"
            size="sm"
            onClick={() => setConnectOpen(true)}
            className="mt-2 gap-1.5"
          >
            <IconSparkles size={16} stroke={1.5} />
            Connect Claude
          </Button>
        </div>
      )}

      <div
        className="flex shrink-0 items-stretch bg-transparent px-0.5 shadow-[inset_0_-1px_0_var(--border)]"
        style={{ height: 'var(--header-h)' }}
      >
        <ThreadPicker
          active={threads.active}
          archived={threads.archived}
          activeId={activeId}
          onSelect={setActiveId}
          onCreate={async () => {
            const id = await threads.createThread()
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
            notify.threadLimitReached()
          }}
        />
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*+*]:mt-3"
      >
        {renderedTurns.length === 0 && (
          // ContentUnavailableView pattern (macOS 14+/iOS 17+):
          // tertiary icon + Title 3 headline + body description.
          // Centered in the otherwise-empty scroll area so the panel
          // never reads as "broken" when no turns exist yet.
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12">
            <IconMessageCircle
              size={48}
              stroke={1.5}
              className="text-muted-foreground/40"
            />
            <p className="text-[16px] font-semibold text-foreground">Ask anything</p>
            <p className="max-w-xs text-center text-[14px] text-muted-foreground">
              Type a message or try a slash command like /proofread.
            </p>
          </div>
        )}
        {renderedTurns.map((turn) => (
          <MessageRow
            key={turn.id}
            turn={turn}
            threadId={activeId}
            threadTitle={activeThread?.title ?? ''}
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
        <PendingEditsBar />
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

