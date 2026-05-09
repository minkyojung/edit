import { useState, useCallback } from 'react'
import type { EditorView } from '@milkdown/kit/prose/view'
import * as Y from 'yjs'
import { runChat } from '@/agent/chat'
import { useChatActivity } from '@/stores/chatActivity'
import { useChatRuns } from '@/stores/chatRuns'
import type { ChatEffort, ChatModel, ChatTurn } from '@/chat/types'
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
  effort?: 'low' | 'medium' | 'high'
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
  ydoc: Y.Doc | null
  activeId: string | null
  activeThreadModel: ChatModel
  activeThreadEffort: ChatEffort
  appendTurn: (turn: ChatTurn) => void
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

  const { editorView, ydoc, activeId, activeThreadModel, activeThreadEffort, appendTurn } = deps

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

      // Counters used by `summarize` (review-comments). Only mutated when
      // a summarize callback is present; otherwise stay at zero and unused.
      let proposedCount = 0
      let appliedCount = 0
      // Mark ids the run produces via propose_change. Always collected (not
      // gated on `summarize`) so handleRegenerate can clear stale marks
      // when re-running any slash command, not just review-comments.
      const appliedMarkIds: string[] = []

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
          appliedMarkIds: appliedMarkIds.length > 0 ? [...appliedMarkIds] : undefined,
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
            buffer.upsert(part)
            flusher.schedule()
          },
          onToolApplied: (call) => {
            if (call.name !== 'propose_change') return
            proposedCount += 1
            if (call.result.ok) {
              appliedCount += 1
              appliedMarkIds.push(call.result.markId)
            }
          },
        })
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
    [editorView, ydoc, activeId, activeThreadModel, activeThreadEffort, appendTurn, startActivity, endActivity],
  )

  return { status, streaming, run }
}
