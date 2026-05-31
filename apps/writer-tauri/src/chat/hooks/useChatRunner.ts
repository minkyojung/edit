import { useState, useCallback } from 'react'
import type { EditorView } from '@milkdown/kit/prose/view'
import { runChat } from '@/agent/chat/index'
import { useChatActivity } from '@/stores/chatActivity'
import { useChatRuns } from '@/stores/chatRuns'
import type { ChatEffort, ChatMode, ChatModel, ChatTurn } from '@/chat/types'
import type { PromptStatus } from '@/chat/PromptInput'
import { classifyRunError } from '@/chat/utils/errorMessage'
import { createStreamingBuffer } from '@/chat/utils/streamingBuffer'
import { createThrottledFlusher } from '@/chat/utils/throttledFlusher'
import { watchOffline } from '@/chat/utils/watchOffline'

/** Optional per-run overrides for slash commands. When provided, the
 * command's rendered body becomes the system prompt, and chat.ts skips
 * its automatic `--- DOCUMENT ---` append (the body owns substitution).
 * `prompt` overrides the history-derived user message — needed because
 * a slash submit is the user message, not a free-text question. */
export type RunOverrides = {
  systemPrompt: string
  prompt: string
  model?: string
  effort?: ChatEffort
  relayTools: string[]
  /** Optional final-content override. Called once the run settles
   * successfully — receives counts of propose_change calls observed,
   * and its return value replaces the assistant turn's text content.
   * Used by /review to render "Found N issues" instead of whatever
   * stray text the model produced alongside its tool calls. */
  summarize?: (counts: { proposed: number; applied: number }) => string
}

interface UseChatRunnerDeps {
  editorView: EditorView | null
  /** Slug of the doc this chat is attached to. Forwarded to runChat so
   * the proposal listener can route by slug instead of relying on a
   * captured (and soon-stale) view reference after doc switch. */
  slug: string | null
  activeId: string | null
  activeThreadModel: ChatModel
  activeThreadEffort: ChatEffort
  /** Active thread's interaction mode. 'plan' makes the turn read-only. */
  activeThreadMode: ChatMode
  appendTurn: (turn: ChatTurn) => void
  /** Called once per run, on the first stream event we receive — the moment
   * the SDK has confirmed a session for this thread. Idempotent at the
   * useThreads layer, so repeating across runs is safe. */
  markSessionStarted: (threadId: string) => void
  /** Authoritative resume hint: true once a session has been confirmed for
   * the thread (read from ThreadMeta.sessionStarted by the caller). Passed
   * straight into runChat so it can skip the legacy history-shape
   * heuristic, which mis-predicts on first-message Regenerate. */
  sessionStarted: boolean
}

export interface ChatRunner {
  status: PromptStatus
  streaming: { threadId: string; turn: ChatTurn } | null
  run: (threadId: string, history: ChatTurn[], overrides?: RunOverrides) => Promise<void>
}

/** Drives a single assistant turn end-to-end: seed streaming buffer, run
 * runChat with the given history, commit on settle. The hook owns the
 * `streaming` buffer state and the chat-level `status` enum that gates
 * Send / regenerate UI. Handlers in ChatPanel call `runner.run(...)` from
 * handleSend / handleRegenerate / executeCommand instead of duplicating
 * the lifecycle. */
export function useChatRunner(deps: UseChatRunnerDeps): ChatRunner {
  const [status, setStatus] = useState<PromptStatus>('idle')
  const [streaming, setStreaming] = useState<{ threadId: string; turn: ChatTurn } | null>(null)
  const startActivity = useChatActivity((s) => s.start)
  const endActivity = useChatActivity((s) => s.end)

  const {
    editorView,
    slug,
    activeId,
    activeThreadModel,
    activeThreadEffort,
    activeThreadMode,
    appendTurn,
    markSessionStarted,
    sessionStarted,
  } = deps

  // No view-change abort: a run started against doc A keeps running
  // after the user switches to doc B. chat.ts's proposal listener
  // routes by slug — proposals land in the target doc's Y.Doc
  // directly (markStore.add) as long as its handle is still open.
  // closeDoc / archiveDoc in docsStore aborts runs whose owning slug
  // is removed, so a truly-destroyed ydoc never receives a late mark.

  const run = useCallback(
    async (threadId: string, history: ChatTurn[], overrides?: RunOverrides) => {
      const startedAt = Date.now()
      const assistantId = crypto.randomUUID()

      // Seed the live assistant turn in local state. No Yjs op fires until
      // the turn settles, so streaming deltas don't trigger collab traffic
      // or whole-list re-renders.
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

      setStatus('streaming')
      startActivity()

      // OS-level "offline" event: fires the moment the user disables Wi-Fi
      // or ethernet drops. We don't wait for the sidecar's 45s idle
      // watchdog in this case — abort immediately so the failure surfaces
      // within a beat. `offline.aborted` lets the catch distinguish this
      // from a user-pressed Stop (which should render as the muted
      // "Stopped" card, not as an error).
      const offline = watchOffline(() => {
        if (activeId) useChatRuns.getState().abortByThread(activeId)
      })

      // Authoritative ordered list of parts for the in-flight assistant
      // turn. chat.ts emits an upsert per state change; the buffer keeps
      // them in arrival order, and the throttled flusher syncs into
      // streaming state behind a 120ms gate so multiple deltas land in
      // one Streamdown commit.
      const buffer = createStreamingBuffer()

      const flusher = createThrottledFlusher(120, () => {
        const parts = buffer.buildParts()
        const content = buffer.joinByType('text')
        const thinking = buffer.joinByType('reasoning')
        setStreaming((s) =>
          s && s.threadId === threadId
            ? {
                ...s,
                turn: { ...s.turn, content, thinking: thinking || undefined, parts },
              }
            : s,
        )
      })

      // Latch for marking the thread's session as started — fires exactly
      // once on the first stream event of this run. Receiving any part
      // means the SDK accepted the request and a session now exists for
      // this thread; future runs must `resume` it regardless of what the
      // history looks like (Regenerate, etc.).
      let sessionMarked = false

      // Counters used by `summarize` (review-comments). Now derived from
      // the final toolCalls list returned by runChat — Phase 3.1.5
      // dropped the host-bridged `edit_document` relay + its per-call
      // onToolApplied callback, so the runner no longer learns about
      // individual edits as they happen. The summarize hook only runs
      // once at settle anyway, so post-hoc filtering is equivalent
      // and keeps the streaming path simpler.
      let proposedCount = 0
      let appliedCount = 0

      const commit = (
        finalStatus: ChatTurn['status'],
        stopReason: string | null,
        errorText: string | null = null,
        errorCode: string | undefined = undefined,
        resetsAt: number | undefined = undefined,
      ) => {
        flusher.cancel()
        const parts = buffer.buildParts()
        const modelText = buffer.joinByType('text')
        const thinking = buffer.joinByType('reasoning')
        // Successful runs with a summarize hook get their text replaced.
        // The parts timeline stays intact so the user can still inspect
        // each propose_change card; only the top-level `content` (used as
        // rendered prose + Copy output + history) becomes the summary line.
        const content =
          finalStatus === 'done' && overrides?.summarize
            ? overrides.summarize({ proposed: proposedCount, applied: appliedCount })
            : modelText
        appendTurn({
          id: assistantId,
          role: 'assistant',
          content,
          thinking: thinking || undefined,
          parts,
          ts: Date.now(),
          status: finalStatus,
          durationMs: Date.now() - startedAt,
          stopReason,
          errorText: errorText ?? undefined,
          errorCode,
          resetsAt,
        })
        setStreaming(null)
      }

      try {
        // Plan turns go read-only: 'plan' permission mode blocks tool
        // execution, and we drop the propose_* relays + Bash so the model
        // explores with Read/Glob/Grep and writes a plan instead of editing.
        const isPlan = activeThreadMode === 'plan'
        const result = await runChat({
          view: editorView!,
          slug: slug!,
          threadId,
          history,
          prompt: overrides?.prompt,
          systemPrompt: overrides?.systemPrompt,
          appendDocument: overrides ? false : undefined,
          relayTools: isPlan ? [] : overrides?.relayTools,
          permissionMode: isPlan ? 'plan' : undefined,
          // AskUserQuestion lets the model ask clarifying questions before
          // planning; it must be in the tool list or the SDK never offers it.
          // (ExitPlanMode + the propose_* relays come with C3.)
          builtinTools: isPlan ? ['Read', 'Glob', 'Grep', 'AskUserQuestion'] : undefined,
          model: overrides?.model ?? activeThreadModel,
          effort: overrides?.effort ?? activeThreadEffort,
          sessionStarted,
          onPart: (part) => {
            if (!sessionMarked) {
              sessionMarked = true
              markSessionStarted(threadId)
            }
            buffer.upsert(part)
            flusher.schedule()
          },
        })
        // Post-hoc edit count for the review-comments summarize hook.
        // Anthropic's built-in Edit/Write tools land in toolCalls with
        // their tool names verbatim; we count each as one proposal and
        // assume success unless the tool_result was an error string.
        const editTools = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
        for (const call of result.toolCalls) {
          if (!editTools.has(call.name)) continue
          proposedCount += 1
          appliedCount += 1
        }
        commit('done', result.stopReason)
        setStatus('idle')
      } catch (e) {
        // Errors live on a dedicated turn field, not in the parts timeline —
        // that keeps prompt history (`buildPrompt`) and Copy output clean,
        // and lets the renderer surface the failure with proper error chrome.
        const outcome = classifyRunError(e, { offlineAborted: offline.aborted })
        commit(outcome.terminal, null, outcome.errorText, outcome.errorCode, outcome.resetsAt)
        setStatus(outcome.chatStatus)
      } finally {
        offline.dispose()
        endActivity()
      }
    },
    [editorView, slug, activeId, activeThreadModel, activeThreadEffort, activeThreadMode, appendTurn, markSessionStarted, sessionStarted, startActivity, endActivity],
  )

  return { status, streaming, run }
}
