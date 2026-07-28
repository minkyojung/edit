// Conversation surface on the right.
//
// Per-document, multi-thread (max 5 active). Each thread persists as a
// Y.Array on the document's Y.Doc, so thread + turn state survives
// reloads and syncs across devices.
//
// This panel is the transcript surface only. Proposed edits are reviewed
// in the document body (inline diff widgets) and in the Review tray, not
// here.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { useChatRuns } from '@/stores/chatRuns'
import { useTurnState, type QueuedTurn } from '@/stores/turnState'
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
  type Attachment,
  type ChatTurn,
  type FileAttachment,
} from '@/chat/types'
import { useChatRunner, type RunOverrides } from '@/chat/hooks/useChatRunner'
import { useVaultCommands } from '@/state/vaultCommandsStore'
import { pathForSlug } from '@/lib/docPaths'
import { MessageRow } from '@/chat/messages/MessageRow'
import { cn } from '@/lib/utils'
import { composeTranscript } from '@/chat/composeTranscript'
import { ScrollToBottomButton } from '@/chat/ScrollToBottomButton'
import {
  REPLY_GAP,
  bottomScrollTop,
  computeAnchorScrollTop,
  nextModeOnScroll,
  shouldFollowFromAnchor,
  type ScrollMode,
} from '@/chat/scroll/scrollMath'
import { ReviewTray } from '@/chat/ReviewTray'
import { SkillProposalTray } from '@/chat/SkillProposalTray'

// Stable empty array for the queued-turns selector. A fresh `[]` per read hands
// zustand a new reference on every streaming tick and re-renders the transcript.
const EMPTY_QUEUE: QueuedTurn[] = []

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
  // in the shared top bar) and passed down here. `slug` is the note the
  // user is currently on — passed independently as per-turn run context
  // (the "current page" the agent sees), not as thread ownership.
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
  // The open note, same shape: the URL slug is the source of truth and a
  // dismissal rides on top, so navigating to another note re-attaches.
  //
  // Unlike the file chip this is NOT reset on send — the note isn't a one-shot
  // attachment, it's where the user still is. Detaching only stops the note
  // being described to the model; `slug` itself is untouched, so edit routing
  // and run bookkeeping still work and the model can act on the note if asked
  // to by name.
  const [noteChipDismissed, setNoteChipDismissed] = useState(false)
  useEffect(() => {
    setNoteChipDismissed(false)
  }, [slug])
  const attachCurrentNote = !noteChipDismissed
  // ONE derivation feeds both the chip and the payload. They used to come from
  // different sources (a prop for the chip, `slug` for the run), which is how
  // they were free to disagree — the whole failure this fixes. `runChat`
  // resolves the path from the same slug through the same `pathForSlug`, so a
  // null here (unknown slug, unplaceable doc) means no chip AND no block.
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const currentNotePath = attachCurrentNote ? pathForSlug(slug, knownDocs) : null
  // The editor's live selection (text + line range), editor-agnostic: the
  // active editor (CodeMirror) publishes it to this store, so the chat reads it
  // without a PM `editorView`. Drives the selection chip and the per-turn
  // `--- SELECTION ---` context block.
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
  const scrollRef = useRef<HTMLDivElement>(null)
  // The composer floats over the transcript (absolute) so chat content can
  // scroll behind its rounded corners instead of being cut off in a straight
  // line above it. We measure its live height — the input grows as you type,
  // and the gate panel swaps in at a different height — and pad the
  // transcript's bottom to match, so the last message always clears it.
  const footerRef = useRef<HTMLDivElement>(null)
  const [footerHeight, setFooterHeight] = useState(0)
  // Synchronous send-in-flight latch, keyed by threadId. Flipping `chatStatus`
  // to 'streaming' only takes effect on the *next* render, so a fast
  // double-Enter could squeeze a second handleSend in before the React state
  // caught up. The set updates immediately on the same tick, so the second
  // call short-circuits before any side effects (turn append, sidecar
  // request). Per-thread so a send on session B isn't blocked by an in-flight
  // send on session A.
  const sendInFlightRef = useRef<Set<string>>(new Set())

  // Single owner of the transcript's scroll position. Every auto-scroll flows
  // through one layout effect that reads this mode — so the bottom-follow and
  // send-anchor behaviours can never issue competing scrollTo()s and race.
  //   FOLLOW_BOTTOM: stick to the bottom, chase new/streamed content (default).
  //   ANCHORED:      pin the just-sent question near the top; reply fills below.
  //   FREE:          user scrolled away to read history — no auto-scroll.
  const [scrollMode, setScrollMode] = useState<ScrollMode>('FOLLOW_BOTTOM')

  // The turn ANCHORED pins to the top. Subordinate data for that mode: which
  // bubble to scroll to. Set alongside ANCHORED on send, cleared on thread
  // switch. `lastScrolledAnchorRef` makes the anchor jump fire once per id, so
  // streaming re-renders don't re-scroll a message that's already in place.
  const [anchorId, setAnchorId] = useState<string | null>(null)
  const lastScrolledAnchorRef = useRef<string | null>(null)
  // Tracks streaming truthiness across renders so we can detect the settle
  // edge (truthy → null) and release a still-ANCHORED short reply.
  const prevStreamingRef = useRef(false)

  // Suppress `handleScroll` while WE are the one scrolling. A programmatic
  // *smooth* scroll fires intermediate `scroll` events whose positions look
  // like "the user scrolled away", which would clobber the mode mid-animation.
  // We set this before such scrolls and clear it on `scrollend` (with a
  // timeout fallback for engines — WKWebView — that don't fire scrollend).
  // Streaming's instant bottom-scrolls are NOT suppressed: they land at the
  // bottom so handleScroll re-affirms FOLLOW_BOTTOM on its own, and leaving
  // them unsuppressed is what lets the user scroll up to pause following.
  const suppressScrollRef = useRef(false)
  const suppressTimerRef = useRef<number | undefined>(undefined)

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

  // Single hook owns the run() dispatcher (the turn lifecycle); the streaming
  // buffer + status it drives live in the per-thread useTurnState store, read
  // just below. Handlers below (handleSend / handleRegenerate /
  // executeCommand) just call `runner.run(...)` instead of duplicating the
  // run lifecycle.
  const runner = useChatRunner({
    isQueue,
    slug,
    attachCurrentNote,
    viewingFilePath,
    selectionText,
    activeThreadModel,
    activeThreadEffort,
    activeThreadMode,
    activeThreadFastMode,
    appendTurn: turnsHook.appendTurn,
    markSessionStarted: threads.markSessionStarted,
    sessionStarted: activeThread?.sessionStarted ?? false,
  })
  // Turn state (status + streaming buffer) lives per-thread in useTurnState.
  // Scope both reads to the VISIBLE thread — a background session's ticks must
  // never gate Send here or re-render/re-scroll this transcript.
  const chatStatus = useTurnState((s) =>
    (activeId ? s.byThread.get(activeId)?.status : undefined) ?? 'idle',
  )
  const streamingTurn = useTurnState((s) =>
    (activeId ? s.byThread.get(activeId)?.streamingTurn : null) ?? null,
  )
  const queuedTurns = useTurnState((s) =>
    (activeId ? s.byThread.get(activeId)?.queued : undefined) ?? EMPTY_QUEUE,
  )

  const handleScroll = useCallback(() => {
    // Ignore our own smooth scrolls (see suppressScrollRef); only genuine user
    // scrolls change the mode.
    if (suppressScrollRef.current) return
    const c = scrollRef.current
    if (!c) return
    const distance = c.scrollHeight - c.scrollTop - c.clientHeight
    setScrollMode(nextModeOnScroll(distance))
  }, [])

  // Issue a programmatic scroll, marking it so handleScroll ignores the
  // resulting events. Streaming's instant bottom-follow passes suppress=false.
  const doScroll = useCallback(
    (c: HTMLElement, top: number, smooth: boolean, suppress: boolean) => {
      if (suppress) {
        suppressScrollRef.current = true
        if (suppressTimerRef.current) window.clearTimeout(suppressTimerRef.current)
        suppressTimerRef.current = window.setTimeout(
          () => {
            suppressScrollRef.current = false
          },
          smooth ? 700 : 150,
        )
      }
      c.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
    },
    [],
  )

  // Position the transcript for a just-sent turn. The FIRST turn in an empty
  // thread follows the bottom instead of anchoring: there's nothing above to
  // scroll past, so pinning a lone bubble to the top over an empty reserved
  // viewport reads as broken — let the reply stream in above the composer.
  // Every later send anchors: sets the target + mode together so the single
  // scroll effect owns the jump. Used by every send path (free chat, slash,
  // vault); pass `isFirstTurn` captured BEFORE the turn is appended.
  const anchorSentTurn = useCallback((turnId: string, isFirstTurn: boolean) => {
    if (isFirstTurn) {
      setScrollMode('FOLLOW_BOTTOM')
    } else {
      setAnchorId(turnId)
      setScrollMode('ANCHORED')
    }
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

  // THE single scroll owner. Reads `scrollMode` and issues at most one
  // scrollTo per run — so bottom-follow and send-anchor can never race. Runs
  // as a layout effect (measures rects, sets scrollTop before paint to avoid a
  // flash) and re-fires whenever the mode, anchor, turns, or streaming buffer
  // change. During streaming, `streamingTurn` is the only dep that ticks (~120ms).
  useLayoutEffect(() => {
    const c = scrollRef.current
    if (!c) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    if (scrollMode === 'ANCHORED' && anchorId) {
      const wrapper = c.querySelector<HTMLElement>(`[data-turn-id="${anchorId}"]`)
      if (!wrapper) return // not committed yet — retry on the next render
      const containerRect = c.getBoundingClientRect()
      const footerH = footerRef.current?.offsetHeight ?? 0

      if (lastScrolledAnchorRef.current !== anchorId) {
        // First time for this turn: fire the anchor jump. Measure the inner
        // content, not the wrapper — the wrapper carries the min-height
        // reservation (see render) which would inflate its rect.
        const content = (wrapper.firstElementChild as HTMLElement | null) ?? wrapper
        lastScrolledAnchorRef.current = anchorId
        const insetTop = parseFloat(getComputedStyle(c).paddingTop) || 0
        const contentRect = content.getBoundingClientRect()
        const top = computeAnchorScrollTop({
          scrollTop: c.scrollTop,
          containerTop: containerRect.top,
          clientHeight: c.clientHeight,
          insetTop,
          footerHeight: footerH,
          bubbleTop: contentRect.top,
          bubbleBottom: contentRect.bottom,
        })
        // Always suppress: after landing, the distance-from-bottom is
        // legitimately large, so an unsuppressed scroll event would flip the
        // mode to FREE and drop the reservation. The send jump is always smooth
        // (unless reduce-motion) — `streamingTurn` is already truthy here because
        // runner.run seeds it synchronously, so we cannot key off it.
        doScroll(c, top, !reduceMotion, true)
        return
      }

      // Already anchored: each streaming tick, check whether the reply has
      // grown enough to fill the viewport, and if so hand off to bottom-follow
      // so the streaming tail stays visible. Skip while our anchor scroll is
      // still animating (suppressScrollRef) — the transient scroll position
      // would misread. Measure the LAST turn's inner content (the reply).
      if (suppressScrollRef.current) return
      const wrappers = c.querySelectorAll<HTMLElement>('[data-turn-id]')
      const lastWrapper = wrappers[wrappers.length - 1]
      const lastContent =
        (lastWrapper?.firstElementChild as HTMLElement | null) ?? lastWrapper
      if (!lastContent) return
      if (
        shouldFollowFromAnchor({
          contentBottom: lastContent.getBoundingClientRect().bottom,
          containerTop: containerRect.top,
          clientHeight: c.clientHeight,
          footerHeight: footerH,
          replyGap: REPLY_GAP,
        })
      ) {
        setScrollMode('FOLLOW_BOTTOM')
      }
      return
    }

    if (scrollMode === 'FOLLOW_BOTTOM') {
      lastScrolledAnchorRef.current = null
      const isStreaming = !!streamingTurn
      // Streaming → instant + unsuppressed (self-correcting, lets the user
      // scroll up to pause). Otherwise smooth + suppressed.
      doScroll(
        c,
        bottomScrollTop(c.scrollHeight, c.clientHeight),
        !isStreaming && !reduceMotion,
        !isStreaming,
      )
    }
    // FREE: nobody auto-scrolls.
  }, [scrollMode, anchorId, turnsHook.turns, streamingTurn, doScroll])

  // Clear the programmatic-scroll suppression as soon as our smooth scroll
  // settles (the timeout in doScroll is only a fallback for engines without
  // scrollend). Also tears down a pending fallback timer on unmount.
  useEffect(() => {
    const c = scrollRef.current
    if (!c) return
    const onScrollEnd = () => {
      suppressScrollRef.current = false
      if (suppressTimerRef.current) window.clearTimeout(suppressTimerRef.current)
    }
    c.addEventListener('scrollend', onScrollEnd)
    return () => {
      c.removeEventListener('scrollend', onScrollEnd)
      if (suppressTimerRef.current) window.clearTimeout(suppressTimerRef.current)
    }
  }, [])

  // When a turn settles (streaming truthy → null) while still ANCHORED, the
  // reply was short enough that it never overflowed into bottom-follow. Leaving
  // it ANCHORED would keep the min-height reservation — a dead viewport of
  // scroll room below a finished short answer, which strands the scroll-to-
  // bottom button and lets the composer's glass band shadow the emptiness.
  // Release to FOLLOW_BOTTOM: the reservation drops and the settled transcript
  // rests naturally (a short answer that fits doesn't move).
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current
    const nowStreaming = !!streamingTurn
    prevStreamingRef.current = nowStreaming
    if (wasStreaming && !nowStreaming && scrollMode === 'ANCHORED') {
      setScrollMode('FOLLOW_BOTTOM')
    }
  }, [streamingTurn, scrollMode])

  // Reset scroll ownership on thread switch so no anchor / reserved room / mode
  // bleeds across; the new thread opens following its latest turn.
  useEffect(() => {
    setAnchorId(null)
    setScrollMode('FOLLOW_BOTTOM')
    lastScrolledAnchorRef.current = null
  }, [activeId])

  // An open doc (`slug`) is enough — edits flow through pendingChangesStore, not
  // a live editor view. The queue route is read-only Q&A; the FileViewer route
  // has neither a view nor a slug but is still a valid chat surface, so gate on
  // being ON that route (`routeFilePath`), NOT on `viewingFilePath`: detaching
  // the file chip must not disable the input — general questions are fine there.
  const ready = !!activeId && (isQueue || !!slug || !!routeFilePath)

  // X-button on the chip detaches the selection: collapse the live selection in
  // whichever editor is mounted (via the store's registered callback). The
  // editor's selection-change listener then publishes the now-empty selection
  // back to the store, so the chip disappears on its own.
  const handleClearSelection = useCallback(() => {
    useEditorSelectionStore.getState().collapse?.()
  }, [])

  // Merge the in-flight streaming turn (local) with the persisted turns (Yjs)
  // for rendering. `streamingTurn` is already scoped to the active thread by
  // its store selector, so a thread-switch mid-stream can't leak another
  // session's buffer into this transcript.
  // Settled → streaming → queued. The ordering lives in composeTranscript so it
  // is under test; inlined here, reversing the last two terms (the original bug)
  // left the whole suite green.
  const renderedTurns = composeTranscript(turnsHook.turns, streamingTurn, queuedTurns)
  const queuedIds = useMemo(
    () => new Set(queuedTurns.map((q) => q.turn.id)),
    [queuedTurns],
  )

  // Drain: the moment the thread goes idle, promote the oldest queued turn into
  // the settled list and run it. `dequeueTurn` removes and returns in one store
  // write and returns null if another drain already took the head, so a double
  // effect fire can't run the same turn twice.
  //
  // Only the VISIBLE thread drains, because chatStatus is selector-scoped to it.
  // Switching away parks the queue rather than losing it — the effect re-runs on
  // the next activeId change, so coming back resumes. That is a pause, not a
  // drop, and it is the behaviour worth having if this ever moves: Zed's queue
  // pauses on stop for the same reason, and its comments name the "frozen queue"
  // bug that draining eagerly produced.
  useEffect(() => {
    if (!activeId || chatStatus === 'streaming' || queuedTurns.length === 0) return
    const next = useTurnState.getState().dequeueTurn(activeId)
    if (!next) return
    turnsHook.appendTurn(next.turn)
    anchorSentTurn(next.turn.id, false)
    void runner.run(
      activeId,
      [...turnsHook.turns, next.turn],
      undefined,
      next.attachments,
      next.mentionPaths,
    )
    // turnsHook / runner are recreated per render; depending on them would fire
    // this on every streaming tick. The gate is chatStatus and the queue length.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, chatStatus, queuedTurns.length])

  // Regenerate is only offered on the most-recent settled assistant turn —
  // rewriting an older one would orphan every later turn's context. Hidden
  // entirely while a turn is in flight.
  const regeneratableTurnId = (() => {
    if (chatStatus === 'streaming' || streamingTurn) return null
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
  /** Run a vault command (organize / daily-ingest / …) NATIVELY: send
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
    const notePath = pathForSlug(slug, useDocsStore.getState().knownDocs)
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

  // Prop-backed context chips (selection + viewing file) snapshotted as turn
  // attachments, so EVERY send path (normal, slash, vault command) can commit
  // them onto its turn uniformly. The draft-backed chips (file / pasted /
  // mentions) are cleared by the composer's own submit, so they never leak.
  function captureContextChips(): Attachment[] {
    const chips: Attachment[] = []
    if (selectionText) {
      chips.push({ type: 'selection', label: selectionLabel ?? 'Selection', preview: selectionText })
    }
    if (viewingFilePath) chips.push({ type: 'viewing-file', path: viewingFilePath })
    return chips
  }
  // Detach the one-shot prop-backed chips once a send has committed them.
  // Selection collapses in the editor (its listener republishes the now-empty
  // selection, hiding the chip); the viewing file is dismissed until the route
  // changes to another file.
  function resetContextChips() {
    if (selectionText) useEditorSelectionStore.getState().collapse?.()
    // The viewed file is NOT detached here, unlike before. It's the same kind of
    // thing as the open note — where the user still IS, not a one-shot
    // attachment — so it stays for as long as they're on that route, and the
    // note chip is kept for the same reason.
    //
    // Dropping it used to be invisible: the file was frozen into the thread's
    // system prompt on turn 1, so the model kept seeing it no matter what the
    // chip did. Now that it rides the per-turn message, detaching on send would
    // mean "summarize this PDF" stops working from the second question on.
    // The X still detaches it, and navigating to another file re-attaches.
  }

  async function handleSend(
    text: string,
    attachments: FileAttachment[] = [],
    mentionPaths: string[] = [],
    pastedTexts: { preview: string; content: string }[] = [],
  ) {
    // No streaming guard: a send while an answer is in flight is QUEUED, not
    // dropped. The sidecar owns the queue (`#dispatchTurn` — strict FIFO, one
    // turn generating at a time), so the two runs never produce output at once
    // and the single per-thread streaming buffer stays correct. PromptInput
    // gates the keyboard path (`canQueue`); the footer button is Stop mid-answer
    // and is unchanged. Regenerate deliberately still refuses mid-answer — it
    // rewrites an existing turn rather than appending one.
    if (!ready) return
    const threadId = activeId
    if (!threadId) return
    // Latch BEFORE any await / state set so a fast double-Enter can't
    // smuggle a duplicate request through while React is still committing
    // the streaming state.
    if (sendInFlightRef.current.has(threadId)) return
    sendInFlightRef.current.add(threadId)
    try {
      // Slash command? Vault commands run natively — the SDK expands the
      // plugin command from `_system/agent/commands/`.
      const slash = parseSlashInvocation(text)
      if (slash) {
        if (useVaultCommands.getState().get(slash.name)) {
          const chips = captureContextChips()
          const userTurn: ChatTurn = {
            id: crypto.randomUUID(),
            role: 'user',
            content: text,
            ts: Date.now(),
            attachments: chips.length > 0 ? chips : undefined,
            slashInvocation: { name: slash.name, args: slash.args },
          }
          const isFirstTurn = turnsHook.turns.length === 0
          turnsHook.appendTurn(userTurn)
          // First turn follows the bottom; later turns anchor to the top.
          anchorSentTurn(userTurn.id, isFirstTurn)
          resetContextChips()
          await runVaultCommand(threadId, slash.name, slash.args, [
            ...turnsHook.turns,
            userTurn,
          ])
          return
        }
        // Unknown command — an error, not a send: leave the chips armed.
        appendInlineError(threadId, text, `Unknown command: /${slash.name}`)
        return
      }

      // Snapshot every composer context chip onto the turn so the bubble renders
      // what was sent: draft-backed file/pasted here + the prop-backed
      // selection/viewing-file via the shared helper (same commit boundary the
      // slash paths use).
      const turnAttachments: Attachment[] = [
        ...attachments.map((f) => ({ type: 'file' as const, name: f.name, mediaType: f.mediaType, path: f.path })),
        ...pastedTexts.map((p) => ({ type: 'pasted' as const, preview: p.preview, content: p.content })),
        ...captureContextChips(),
      ]
      const userTurn: ChatTurn = {
        id: crypto.randomUUID(),
        role: 'user',
        content: text,
        ts: Date.now(),
        attachments: turnAttachments.length > 0 ? turnAttachments : undefined,
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

      // Detach the one-shot prop-backed chips now that they're committed to the
      // turn (draft chips were already cleared by the composer's submit).
      // Done before the queue branch so a parked turn keeps the context it was
      // written against rather than whatever is on screen when it finally runs.
      resetContextChips()

      // Answer still streaming → park it. NOT appendTurn: the settled list
      // renders above the streaming answer, so committing it now would drop the
      // message into the middle of the transcript instead of the end.
      //
      // The frontend owns this queue even though the sidecar has one of its own
      // (#dispatchTurn, FIFO). Dispatching late is what buys the affordances:
      // cancel, edit and reorder are array operations here, whereas a turn the
      // sidecar has already accepted would need a control-protocol message to
      // retract — and the SDK's own cancel for that is untyped.
      if (chatStatus === 'streaming') {
        useTurnState
          .getState()
          .enqueueTurn(threadId, { turn: userTurn, attachments, mentionPaths })
        return
      }

      // The user's turn is finished text — push to Yjs once and let it sync.
      turnsHook.appendTurn(userTurn)
      // First turn follows the bottom; later turns anchor to the top.
      anchorSentTurn(userTurn.id, isFirstTurn)

      await runner.run(threadId, [...turnsHook.turns, userTurn], undefined, attachments, mentionPaths)
    } finally {
      sendInFlightRef.current.delete(threadId)
    }
  }

  /** Regenerate the assistant turn at `assistantTurnId` — removes it, then
   * re-runs the model against the history up to (and including) the user
   * message that prompted it. Only valid for the most recent assistant turn:
   * earlier rewrites would invalidate every later turn's context.
   *
   * Slash-command turns (`slashInvocation` stamped on the user turn) rerun
   * through the vault-command path, so the SDK expands the plugin command
   * again instead of replaying the literal `/organize` text as plain chat. */
  async function handleRegenerate(assistantTurnId: string) {
    if (!ready || chatStatus === 'streaming') return
    const threadId = activeId
    if (!threadId) return
    if (sendInFlightRef.current.has(threadId)) return
    sendInFlightRef.current.add(threadId)
    try {
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
      // Follow the bottom as the reply re-streams in place — no re-anchor jump,
      // which would yank a settled transcript around.
      setScrollMode('FOLLOW_BOTTOM')

      if (lastUser.slashInvocation) {
        // Vault command → rerun natively.
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
      // Re-derive the turn's file attachments + @-mentions from what was
      // committed onto it, so the rerun sees the same context as the original
      // send (without this, regenerate silently dropped them). Pasted text +
      // selection ride on turn.content / buildUserPrompt already. Old turns
      // predate persisted paths — skip any file attachment missing one.
      const regenAttachments: FileAttachment[] = (lastUser.attachments ?? [])
        .filter((a): a is Extract<Attachment, { type: 'file' }> => a.type === 'file' && !!a.path)
        .map((a) => ({ id: crypto.randomUUID(), name: a.name, mediaType: a.mediaType, path: a.path }))
      const regenMentions = (lastUser.mentions ?? []).map((m) => m.path)
      await runner.run(threadId, history, undefined, regenAttachments, regenMentions)
    } finally {
      sendInFlightRef.current.delete(threadId)
    }
  }

  function handleStop() {
    if (activeId) useChatRuns.getState().abortByThread(activeId)
  }

  // Pre-submit validator: blocks unknown commands. Free chat (no leading
  // slash) is always ok, and the leading-slash branch returns ok while the
  // user is still typing the name (no space yet) so the palette — not a red
  // error — handles the in-progress state.
  const validatePrompt = useCallback((text: string) => {
    const m = /^\/([a-z][a-z0-9-]*)(\s|$)/.exec(text)
    if (!m) return { ok: true as const }
    const hasSpace = m[2].length > 0
    if (useVaultCommands.getState().get(m[1])) return { ok: true as const }
    return hasSpace
      ? { ok: false as const, message: `Unknown command: /${m[1]}` }
      : { ok: true as const }
  }, [])

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
        // Top: clear the glass fade band (RightPanel) — same --chat-top-inset
        // token, so content begins exactly where the band goes transparent and
        // the first message is never painted over.
        // Bottom: clear the composer AND its glass fade band (footerHeight + 48
        // below) so the resting last message isn't shadowed by the fade. Must
        // match that band height; content still dissolves under it while
        // scrolling, but nothing rests inside the fade.
        style={{ paddingTop: 'var(--chat-top-inset)', paddingBottom: footerHeight + 48 }}
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
        {renderedTurns.map((turn, i) => (
          // data-turn-id lets the anchor effect find this bubble to scroll it to
          // the top (the effect computes the offset itself). The wrapper is the
          // scroll container's direct child, so [&>*+*]:mt-6 still spaces turns.
          //
          // ANCHOR mode reserves a viewport of scroll room by giving the LAST
          // turn's wrapper a min-height. Pure CSS, self-trimming: a short reply
          // is padded so the anchored message can sit at the top; a reply that
          // already fills the viewport doesn't grow the wrapper, so there's no
          // trailing void. min-height on the wrapper (not the bubble) keeps the
          // bubble its natural size at the top of the padded box.
          <div
            key={turn.id}
            data-turn-id={turn.id}
            // Queued turns read as sent-but-waiting. Dimming is the whole
            // signal: the bubble is in the transcript at the position it will
            // occupy, just not live yet. VS Code uses 0.7 for the same state.
            className={cn(queuedIds.has(turn.id) && 'opacity-60')}
            aria-busy={queuedIds.has(turn.id) || undefined}
            style={
              scrollMode === 'ANCHORED' && i === renderedTurns.length - 1
                ? { minHeight: 'calc(100dvh - var(--chat-top-inset))' }
                : undefined
            }
          >
            <MessageRow
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
          </div>
        ))}
        {pendingPlanText && (
          <div className="px-1 text-[15px] leading-relaxed text-foreground">
            <StreamingMarkdown content={pendingPlanText} isStreaming={false} />
          </div>
        )}
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
          // Only when the user has deliberately scrolled up (FREE) — never
          // during an ANCHORED send (the pin is intentional; there's no real
          // content below to jump to).
          visible={scrollMode === 'FREE' && renderedTurns.length > 0}
          onClick={() => setScrollMode('FOLLOW_BOTTOM')}
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
            threadId={activeId}
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
            currentNotePath={currentNotePath}
            currentNoteLabel={noteLabel}
            onClearCurrentNote={() => setNoteChipDismissed(true)}
          />
        )}
      </div>
    </div>
  )
}

