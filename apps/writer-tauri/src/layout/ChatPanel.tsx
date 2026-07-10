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
import { useLocation } from 'react-router-dom'
import { parseFilePathFromPath } from '@/lib/viewUrl'
import { IconMessageCircle, IconSparkles } from '@tabler/icons-react'
import { useEditorSelectionStore } from '@/state/editorSelectionStore'
import { useDocsStore } from '@/state/docsStore'
import { useDocLabel } from '@/hooks/useDocLabel'
import { Button } from '@/components/ui/button'
import { useClaudeAuth } from '@/hooks/useClaudeAuth'
import { useConnectDialog } from '@/stores/connectDialog'
import { type UseThreadsResult } from '@/hooks/useThreads'
import { useThreadTurns } from '@/hooks/useThreadTurns'
import { generateThreadTitle } from '@/agent/generateThreadTitle'
import {
  CommandRenderError,
  getCommand,
  renderBody,
  resolveKind,
  type LoadedCommand,
} from '@/chat/commands'
import { useChatRuns } from '@/stores/chatRuns'
import { useContextUsageStore } from '@/state/contextUsageStore'
import { useFastModeStore } from '@/state/fastModeStore'
import { usePendingPermissions } from '@/state/pendingPermissionsStore'
import { usePermissionGate } from '@/chat/hooks/usePermissionGate'
import { GatePanel } from '@/chat/GatePanel'
import { StreamingMarkdown } from '@/chat/ui/StreamingMarkdown'
import { PromptInput } from '@/chat/PromptInput'
import {
  DEFAULT_CHAT_EFFORT,
  DEFAULT_CHAT_MODE,
  clampEffort,
  normalizeModel,
  type ChatTurn,
  type FileAttachment,
} from '@/chat/types'
import { useChatRunner, type RunOverrides } from '@/chat/hooks/useChatRunner'
import { useVaultCommands } from '@/state/vaultCommandsStore'
import { pathForDoc } from '@/lib/docPaths'
import { MessageRow } from '@/chat/messages/MessageRow'
import { ScrollToBottomButton } from '@/chat/ScrollToBottomButton'
import { ReviewTray } from '@/chat/ReviewTray'
import { SkillProposalTray } from '@/chat/SkillProposalTray'

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
  slug: string | null
  // Threads + active id are owned by RightPanel (so the picker can sit
  // in the shared top bar) and passed down here. `slug` is still passed
  // independently — it's informational, stamping `parentSlug` on newly-
  // created threads — and feeds the run dispatcher.
  threads: UseThreadsResult
  activeId: string | null
}

export function ChatPanel({ slug, threads, activeId }: Props) {
  // Read Later queue route: no editor document, so chat runs read-only with
  // a generated article-list page context (see useChatRunner / runChat).
  const pathname = useLocation().pathname
  const isQueue = pathname === '/read-later'
  // FileViewer route (`/file/:rel`): a non-markdown file (PDF/image/…) is open.
  // There's no slug/editor for it, so this path is the only signal the chat
  // gets about what the user is looking at.
  const routeFilePath = parseFilePathFromPath(pathname)
  // The file chip is detachable: the user can drop the open file from the
  // chat's context via its X. Tracked as a dismissal so we can keep using the
  // route as the source of truth — opening a different file (route change)
  // re-attaches automatically.
  const [fileChipDismissed, setFileChipDismissed] = useState(false)
  useEffect(() => {
    setFileChipDismissed(false)
  }, [routeFilePath])
  // What the chat actually sees / the chip renders: null once detached.
  const viewingFilePath = routeFilePath && !fileChipDismissed ? routeFilePath : null
  // The editor's live selection (text + line range), editor-agnostic: the
  // active editor (CodeMirror) publishes it to this store, so the chat reads it
  // without a PM `editorView`. Drives the selection chip, the slash-command
  // Send gate (hasSelection), and free-chat selection context.
  const selection = useEditorSelectionStore((s) => s.selection)
  const noteLabel = useDocLabel(slug)
  const selectionText = selection?.text ?? null
  // Chip label uses the editor's metadata — "Note · L10–14" — rather than a
  // text snippet, so it reads like a code-editor reference.
  const selectionLabel = selection
    ? `${noteLabel || 'Selection'} · L${selection.fromLine}` +
      (selection.toLine !== selection.fromLine ? `–${selection.toLine}` : '')
    : null
  const { account } = useClaudeAuth()
  const setConnectOpen = useConnectDialog((s) => s.setOpen)
  const turnsHook = useThreadTurns(activeId)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // The composer floats over the transcript (absolute) so chat content can
  // scroll behind its rounded corners instead of being cut off in a straight
  // line above it. We measure its live height — the input grows as you type,
  // and the gate panel swaps in at a different height — and pad the
  // transcript's bottom to match, so the last message always clears it.
  const footerRef = useRef<HTMLDivElement>(null)
  const [footerHeight, setFooterHeight] = useState(0)
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
  // normalizeModel coerces a retired stored id (e.g. claude-opus-4-7) to a
  // current one, and clampEffort snaps a stored `xhigh` down to `high` when
  // the resolved model doesn't support it — so both the UI and the SDK call
  // always see a valid pairing even for legacy threads.
  const activeThread = threads.threads.find((t) => t.id === activeId)
  const activeThreadModel = normalizeModel(activeThread?.model)
  const activeThreadEffort = clampEffort(
    activeThread?.effort ?? DEFAULT_CHAT_EFFORT,
    activeThreadModel,
  )
  const activeThreadMode = activeThread?.mode ?? DEFAULT_CHAT_MODE
  const activeThreadFastMode = activeThread?.fastMode ?? false

  // Post-turn context-usage snapshot for the PromptInput gauge. Subscribed
  // reactively so the gauge refreshes the moment the chat runner records a
  // new snapshot on `claude:done`.
  const contextSnapshot = useContextUsageStore((s) =>
    activeId ? s.byThread[activeId] : undefined,
  )
  // Actual fast-mode state the SDK last reported (on / cooldown / off) — drives
  // the FastToggle's real-state display, refreshed on each claude:done.
  const fastModeState = useFastModeStore((s) =>
    activeId ? s.byThread[activeId] : undefined,
  )

  // Plan-mode interactive gate: mount the global `claude:permission` listener
  // and read the pending decision (if any) for the active thread, so the
  // matching card can render inline in the transcript.
  usePermissionGate()
  const pendingPermission = usePendingPermissions((s) =>
    activeId ? Object.values(s.byRun).find((p) => p.threadId === activeId) : undefined,
  )
  // Plan mode puts the plan in ExitPlanMode's `plan` arg (the chat answer stays
  // minimal). Render it as the assistant's answer in the transcript — the card
  // below is the decision surface only.
  const pendingPlanText =
    pendingPermission?.toolName === 'ExitPlanMode'
      ? (pendingPermission.input as { plan?: string } | null)?.plan?.trim()
      : undefined

  // Single hook owns the streaming buffer state, the chat-level status, and
  // the run() dispatcher. Handlers below (handleSend / handleRegenerate /
  // executeCommand) just call `runner.run(...)` instead of duplicating the
  // run lifecycle.
  const runner = useChatRunner({
    isQueue,
    slug,
    viewingFilePath,
    selectionText,
    activeId,
    activeThreadModel,
    activeThreadEffort,
    activeThreadMode,
    activeThreadFastMode,
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

  // Track the floating composer's height so the transcript's bottom padding
  // matches it. A ResizeObserver keeps it in sync as the input grows or the
  // gate panel swaps in.
  useEffect(() => {
    const el = footerRef.current
    if (!el) return
    const sync = () => setFooterHeight(el.offsetHeight)
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
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

  // An open doc (`slug`) is enough — edits flow through pendingChangesStore, not
  // a live editor view. The queue route is read-only Q&A; the FileViewer route
  // has neither a view nor a slug but is still a valid chat surface, so gate on
  // being ON that route (`routeFilePath`), NOT on `viewingFilePath`: detaching
  // the file chip must not disable the input — general questions are fine there.
  const ready = !!activeId && (isQueue || !!slug || !!routeFilePath)

  // Whether the editor has a non-empty selection — gates selection-scoped
  // slash commands (validatePrompt). Sourced from the same editor-agnostic
  // store as the chip.
  const hasSelection = selection !== null

  // "Edit with AI" from a viz block's toolbar arms a one-shot: it carries the
  // block's stable id, and the NEXT chat message becomes an edit instruction for
  // THAT block. The send (handleSend) hands the run a `vizEditTarget` so the
  // SAME chat agent edits it via the edit_visualization tool — not a separate
  // pipeline. Holds the target vizId (or null when disarmed); cleared after it
  // fires or the selection is detached.
  const editingVizRef = useRef<string | null>(null)
  useEffect(() => {
    const arm = (e: Event) => {
      const id = (e as CustomEvent<{ vizId?: string }>).detail?.vizId
      if (id) editingVizRef.current = id
    }
    window.addEventListener('writer:viz-edit', arm)
    return () => window.removeEventListener('writer:viz-edit', arm)
  }, [])

  // X-button on the chip detaches the selection: collapse the live selection in
  // whichever editor is mounted (via the store's registered callback). The
  // editor's selection-change listener then publishes the now-empty selection
  // back to the store, so the chip disappears on its own.
  const handleClearSelection = useCallback(() => {
    editingVizRef.current = null
    useEditorSelectionStore.getState().collapse?.()
  }, [])

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
      if (turnsHook.turns[i].role === 'assistant') {
        // Don't offer Regenerate on a continuation that follows an
        // AskUserQuestion answer bubble: its history slice would end at the
        // synthetic user turn, so re-running resumes past the already-answered
        // question with mismatched semantics.
        if (turnsHook.turns[i - 1]?.synthetic) return null
        // A refusal won't change on a re-run of the same prompt — offering
        // Regenerate is a dead button. Suppress it; the user can still edit
        // the prompt and send a fresh message.
        if (turnsHook.turns[i].stopReason === 'refusal') return null
        return turnsHook.turns[i].id
      }
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
      // Document + selection from the editor-agnostic sources CM publishes: the
      // open doc's bodyMarkdown cache and the live selection store (the same one
      // the chip reads). render.ts throws CommandRenderError when scope is
      // "selection" and nothing is selected — surfaced as an inline error below.
      const docText = slug
        ? (useDocsStore.getState().handles[slug]?.bodyMarkdown ?? '')
        : ''
      systemPrompt = renderBody(cmd, {
        document: docText,
        selection: selectionText ?? '',
        args,
      })
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

  /** Run a vault routine command (organize / daily-ingest / …) NATIVELY: send
   * `/<name> <arg>` as the prompt so the SDK expands the plugin command. The arg
   * defaults to the open note's path — the "organize what I'm looking at"
   * default — unless the user typed one. No client system prompt: the command
   * body arrives via SDK expansion, and an empty systemBody keeps the chat
   * persona out. Caller has already appended `userTurn` to `history`. */
  async function runVaultCommand(
    threadId: string,
    name: string,
    args: string,
    history: ChatTurn[],
  ) {
    const knownDocs = useDocsStore.getState().knownDocs
    const doc = slug ? knownDocs.find((d) => d.slug === slug) : undefined
    const notePath = doc
      ? pathForDoc(doc, (s) => knownDocs.find((d) => d.slug === s))
      : null
    const arg = args.trim() || notePath || ''
    const overrides: RunOverrides = {
      systemPrompt: '',
      prompt: arg ? `/${name} ${arg}` : `/${name}`,
      relayTools: ['propose_edit', 'propose_multi_edit', 'propose_write', 'move_note'],
    }
    await runner.run(threadId, history, overrides)
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

  async function handleSend(
    text: string,
    attachments: FileAttachment[] = [],
    mentionPaths: string[] = [],
  ) {
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
        if (cmd) {
          await executeCommand(threadId, cmd, slash.args, text)
          return
        }
        // Not a builtin editor action — is it a vault routine command? Those
        // run natively (the SDK expands the plugin command).
        if (useVaultCommands.getState().get(slash.name)) {
          const userTurn: ChatTurn = {
            id: crypto.randomUUID(),
            role: 'user',
            content: text,
            ts: Date.now(),
            slashInvocation: { name: slash.name, args: slash.args },
          }
          turnsHook.appendTurn(userTurn)
          await runVaultCommand(threadId, slash.name, slash.args, [
            ...turnsHook.turns,
            userTurn,
          ])
          return
        }
        appendInlineError(threadId, text, `Unknown command: /${slash.name}`)
        return
      }

      // Viz "Edit with AI" read the target block's source from the PM view to
      // hand the agent its current spec; that path doesn't exist on CM. Clear
      // any stale arm so it can't leak into this send.
      editingVizRef.current = null

      const userTurn: ChatTurn = {
        id: crypto.randomUUID(),
        role: 'user',
        content: text,
        ts: Date.now(),
        attachments: attachments.length > 0
          ? attachments.map(f => ({ type: 'file' as const, name: f.name, mediaType: f.mediaType }))
          : undefined,
        mentions: mentionPaths.length > 0
          ? mentionPaths.map((path) => ({ path }))
          : undefined,
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

      await runner.run(threadId, [...turnsHook.turns, userTurn], undefined, undefined, attachments, mentionPaths)
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
        // Vault routine command → rerun natively.
        if (useVaultCommands.getState().get(lastUser.slashInvocation.name)) {
          await runVaultCommand(
            threadId,
            lastUser.slashInvocation.name,
            lastUser.slashInvocation.args,
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
        // Vault routine commands are valid too — they execute natively.
        if (useVaultCommands.getState().get(m[1])) return { ok: true as const }
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
      className="relative flex h-full flex-col"
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
          <p className="text-title-3 font-semibold text-foreground">
            Connect Claude
          </p>
          <p className="max-w-xs text-center text-body text-muted-foreground">
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
        ref={scrollRef}
        onScroll={handleScroll}
        // Aligns the transcript text with the composer's textarea text, so
        // messages and the input share one column. Composer text sits at
        // --surface-inset (footer) + PromptInput p-2.5 (10px) + textarea
        // px-1.5 (6px) = --surface-inset + 1rem from the card edge, so this
        // tracks the gap automatically.
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-[calc(var(--surface-inset)_+_1rem)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*+*]:mt-6"
        // Top: clear the overlay header (content scrolls behind it).
        // Bottom: clear the floating composer so the last message isn't hidden.
        style={{ paddingTop: 'calc(var(--header-h) + 0.25rem)', paddingBottom: footerHeight + 12 }}
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
            <p className="text-title-3 font-semibold text-foreground">Ask anything</p>
            <p className="max-w-xs text-center text-body text-muted-foreground">
              Type a message, or type / for commands.
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
            // While a plan is parked for approval, its plan lives in the
            // approval card — hide the (redundant) answer text so the plan
            // isn't shown twice.
            hideText={
              turn.status === 'streaming' &&
              pendingPermission?.toolName === 'ExitPlanMode'
            }
          />
        ))}
        {pendingPlanText && (
          <div className="px-1 text-[15px] leading-relaxed text-foreground">
            <StreamingMarkdown content={pendingPlanText} isStreaming={false} />
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Glass fade band: the transcript dissolves into the composer instead
          of stopping in a hard line, and content can't harshly pool below it.
          Frosted panel colour, fully covering the composer area, masked to
          fade to transparent just above it — so content softly disappears as
          it scrolls under. Sits behind the composer (painted first) and over
          the transcript. Mirrors the editor's header/footer glass bands. */}
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-0 left-0 right-0 bg-background/90"
        style={{
          height: footerHeight + 48,
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          maskImage: `linear-gradient(to top, black, black ${footerHeight}px, transparent)`,
          WebkitMaskImage: `linear-gradient(to top, black, black ${footerHeight}px, transparent)`,
        }}
      />

      <div
        ref={footerRef}
        className="absolute bottom-0 left-0 right-0 px-[var(--surface-inset)] pb-[var(--surface-inset)]"
      >
        <ScrollToBottomButton
          visible={!pinned && renderedTurns.length > 0}
          onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}
        />
        {/* Pending AI changes, grouped by file — sits above the input, hides when empty. */}
        <ReviewTray />
        {/* Proposed skills (propose_skill) — same slot, separate store. */}
        <SkillProposalTray />
        {pendingPermission?.toolName === 'AskUserQuestion' ||
        pendingPermission?.toolName === 'ExitPlanMode' ? (
          // Any parked gate (clarifying question or plan approval) takes the
          // prompt input's place. GatePanel routes to the right inner panel by
          // tool; ✕ stops the turn via the existing abort path.
          <GatePanel pending={pendingPermission} onClose={handleStop} />
        ) : (
          <PromptInput
            status={chatStatus}
            disabled={!ready || !account.connected}
            onSubmit={handleSend}
            onStop={handleStop}
            model={activeThreadModel}
            onModelChange={(m) => activeId && threads.setThreadModel(activeId, m)}
            effort={activeThreadEffort}
            onEffortChange={(e) => activeId && threads.setThreadEffort(activeId, e)}
            mode={activeThreadMode}
            onModeChange={(m) => activeId && threads.setThreadMode(activeId, m)}
            fastMode={activeThreadFastMode}
            onFastModeChange={(v) => activeId && threads.setThreadFastMode(activeId, v)}
            fastModeState={fastModeState}
            contextSnapshot={contextSnapshot}
            validate={validatePrompt}
            selectionText={selectionText}
            selectionLabel={selectionLabel}
            onClearSelection={handleClearSelection}
            viewingFilePath={viewingFilePath}
            onClearViewingFile={() => setFileChipDismissed(true)}
          />
        )}
      </div>
    </div>
  )
}

