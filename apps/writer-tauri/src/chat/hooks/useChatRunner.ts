import { useState, useCallback } from 'react'
import { runChat } from '@/agent/chat/index'
import { flushDirty } from '@/lib/docFileSync'
import { useChatActivity } from '@/stores/chatActivity'
import { useChatRuns } from '@/stores/chatRuns'
import { modelSupportsFastMode } from '@/chat/types'
import type { ChatEffort, ChatMode, ChatModel, ChatTurn, FileAttachment } from '@/chat/types'
import type { VizEditTarget } from '@/agent/chat/types'
import type { PromptStatus } from '@/chat/PromptInput'
import { classifyRunError } from '@/chat/utils/errorMessage'
import { createStreamingBuffer } from '@/chat/utils/streamingBuffer'
import { createThrottledFlusher } from '@/chat/utils/throttledFlusher'
import { watchOffline } from '@/chat/utils/watchOffline'
import { notifyJobDone } from '@/lib/notifyOs'
import { useAnsweredQuestions } from '@/state/answeredQuestionsStore'
import { useThreadsStore } from '@/state/threadsStore'
import { buildQueueContextMarkdown } from '@/agent/chat/buildQueueContext'

/** Synthetic slug for chat turns started on the Read Later queue (no
 * document). Only used as the run-registry key; there's no doc to route
 * edits to (queue turns are read-only Q&A). */
const QUEUE_SLUG = 'read-later:queue'

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
  /** True when the chat is running on the Read Later queue route (no
   * document mounted). Turns run read-only with a generated article-list
   * page context instead of editor text. */
  isQueue: boolean
  /** Slug of the doc this chat is attached to. Forwarded to runChat so
   * the proposal listener can route by slug instead of relying on a
   * captured (and soon-stale) view reference after doc switch. */
  slug: string | null
  /** Vault-relative path of a non-markdown file open in the FileViewer
   * (`/file/:rel`) route — null on every other surface. Forwarded to runChat
   * so the agent knows which file the user is looking at. */
  viewingFilePath: string | null
  /** Editor text currently selected (live or frozen snapshot), or null. For
   * free-chat turns it's forwarded to runChat as a `--- SELECTION ---` block
   * so "explain this" focuses on the selection. */
  selectionText: string | null
  activeId: string | null
  activeThreadModel: ChatModel
  activeThreadEffort: ChatEffort
  /** Active thread's interaction mode. 'plan' makes the turn read-only. */
  activeThreadMode: ChatMode
  /** Active thread's fast-mode preference. Only forwarded to the SDK when the
   * resolved model supports it (gated here). */
  activeThreadFastMode: boolean
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
  run: (
    threadId: string,
    history: ChatTurn[],
    overrides?: RunOverrides,
    vizEditTarget?: VizEditTarget,
    attachments?: FileAttachment[],
    mentionPaths?: string[],
  ) => Promise<void>
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
    isQueue,
    slug,
    viewingFilePath,
    selectionText,
    activeId,
    activeThreadModel,
    activeThreadEffort,
    activeThreadMode,
    activeThreadFastMode,
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
    async (
      threadId: string,
      history: ChatTurn[],
      overrides?: RunOverrides,
      vizEditTarget?: VizEditTarget,
      attachments?: FileAttachment[],
      mentionPaths?: string[],
    ) => {
      const startedAt = Date.now()
      // Label for the OS completion ping — the user's request, truncated.
      const jobTitle =
        [...(history ?? [])]
          .reverse()
          .find((t) => t.role === 'user' && !t.synthetic)
          ?.content?.trim()
          .slice(0, 60) || 'Chat finished'
      // Discard any answer summary left over from a prior run (e.g. one whose
      // tool result never arrived because the turn was aborted) so this run's
      // questions can't inherit a stale bubble.
      useAnsweredQuestions.getState().take(threadId)
      // `let`, not `const`: an AskUserQuestion answer splits the turn — the
      // pre-question content commits as one assistant turn, then a fresh
      // streaming turn (new id) carries the post-answer continuation. See
      // `rotateForAnswer` below.
      let assistantId = crypto.randomUUID()

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
      // `let`: rotateForAnswer swaps in a fresh buffer for the post-answer
      // turn so the continuation's parts don't co-mingle with the committed
      // pre-question turn. The flusher/commit/onPart closures read `buffer`
      // by reference, so they always see the current one.
      let buffer = createStreamingBuffer()

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

      // Session-started marking now happens via runChat's onSessionStart
      // (fired on the first claude:event, the SDK's session-init signal),
      // not on the first content part — see that callback below.

      // Counters used by `summarize` (review-comments). Assigned once at
      // settle from runChat's `editCount` (derived from pendingChangesStore
      // by runId). The summarize hook only runs once at settle, so a single
      // post-hoc read is equivalent and keeps the streaming path simple.
      let proposedCount = 0
      let appliedCount = 0

      const commit = (
        finalStatus: ChatTurn['status'],
        stopReason: string | null,
        errorText: string | null = null,
        errorCode: string | undefined = undefined,
        resetsAt: number | undefined = undefined,
        rateLimitType: string | undefined = undefined,
        retryable: boolean | undefined = undefined,
        overageDisabledReason: string | undefined = undefined,
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
          rateLimitType,
          overageDisabledReason,
          retryable,
        })
        setStreaming(null)
      }

      // AskUserQuestion answers we've already split on — guards against a
      // second onPart for the same resolved tool part re-triggering a rotate.
      const rotatedQuestionPartIds = new Set<string>()

      // Split the in-flight assistant turn at an answered clarifying question.
      // The SDK delivers the answer as the AskUserQuestion tool result, which
      // arrives BEFORE the model streams its continuation — so at this instant
      // the buffer holds exactly the pre-question content. We:
      //   1. stamp the chosen answer onto the AskUserQuestion part (the SDK
      //      output echoes only the options, not the selection),
      //   2. commit that as a finished assistant turn — the answered question
      //      now renders inline as a QuestionActivity row, so there is no
      //      separate synthetic "you answered" bubble,
      //   3. start a fresh streaming turn + buffer for the continuation.
      const rotateForAnswer = (qaText: string) => {
        flusher.cancel()
        const parts = buffer.buildParts().map((p) =>
          p.type === 'tool' && p.toolName === 'AskUserQuestion' && !p.answer
            ? { ...p, answer: qaText }
            : p,
        )
        const content = buffer.joinByType('text')
        const thinking = buffer.joinByType('reasoning')
        // Commit whenever there's anything to show. The answered question lives
        // in `parts` now, so a question-only turn is worth keeping.
        const hasContent =
          content.trim().length > 0 || thinking.trim().length > 0 || parts.length > 0
        const toAppend: ChatTurn[] = []
        if (hasContent) {
          toAppend.push({
            id: assistantId,
            role: 'assistant',
            content,
            thinking: thinking || undefined,
            parts,
            ts: Date.now(),
            status: 'done',
            durationMs: Date.now() - startedAt,
            stopReason: null,
          })
        }
        // Swap to a fresh streaming turn + buffer BEFORE persisting, so any
        // continuation part that races in lands on the new turn (it's post-
        // answer content), never back on the committed pre-question turn.
        assistantId = crypto.randomUUID()
        buffer = createStreamingBuffer()
        setStreaming({
          threadId,
          turn: { id: assistantId, role: 'assistant', content: '', ts: Date.now(), status: 'streaming' },
        })
        void useThreadsStore.getState().appendTurns(threadId, toAppend)
      }

      try {
        // Flush the editor's unsaved body to disk BEFORE the turn so the agent's
        // file tools (read_page) and the propose_edit anchor see the same content the
        // user sees — otherwise the model reads a stale .md and its old_string won't
        // match the live doc. Idempotent (skips unchanged docs).
        await flushDirty()
        // Plan turns go read-only: 'plan' permission mode blocks tool
        // execution, and we drop the propose_* relays + Bash so the model
        // explores with Read/Glob/Grep and writes a plan instead of editing.
        const isPlan = activeThreadMode === 'plan'
        const result = await runChat({
          // Queue turns have no doc; a synthetic slug keeps run-registry
          // bookkeeping happy. Edits never target it (read-only Q&A).
          slug: slug ?? QUEUE_SLUG,
          // On the queue, feed the saved-article list as the "current page".
          pageContextMarkdown: isQueue ? buildQueueContextMarkdown() : undefined,
          viewingFilePath,
          // Free-chat only: slash commands already fold the selection into
          // their rendered body via {{selection}}, so passing it here too
          // would double-inject. overrides ⇒ slash command ⇒ skip.
          selectionText: overrides ? undefined : selectionText,
          // @-mentioned files (free chat only; slash commands don't carry them).
          mentionPaths: overrides ? undefined : mentionPaths,
          threadId,
          history,
          prompt: overrides?.prompt,
          systemPrompt: overrides?.systemPrompt,
          appendDocument: overrides ? false : undefined,
          attachments: overrides ? undefined : attachments,
          // Editing a specific viz block: runChat adds the edit_visualization
          // relay tool + injects the target's id/spec into the system prompt.
          vizEditTarget,
          // Plan turns keep the propose_* relays available so the model can
          // execute once the plan is approved. The gate (sidecar canUseTool)
          // denies them while planning and allows them after ExitPlanMode is
          // approved; reads go through the built-in Read/Glob/Grep throughout.
          // Queue turns are read-only: no propose_* (there's no doc to edit);
          // the model reads article bodies via the built-in Read/Glob/Grep.
          relayTools: isPlan
            ? ['propose_edit', 'propose_write']
            : isQueue
              ? []
              : overrides?.relayTools,
          // 'default' (not bypass) so the sidecar's canUseTool gate fires and
          // the model can pause on AskUserQuestion mid-chat; the gate passes
          // every other tool straight through, so this matches the old bypass
          // behaviour otherwise. (Plan turns keep 'plan'.)
          permissionMode: isPlan ? 'plan' : 'default',
          // acceptEdits mode: same sidecar path as edit (propose_* relays,
          // 'default' gate), but the host auto-accepts each proposal the moment
          // it lands — applied without a manual Keep. Mirrors the SDK's
          // 'acceptEdits' behaviour within our staged-review architecture.
          autoAcceptEdits: activeThreadMode === 'acceptEdits',
          // Interactive plan tools must be in the list or the SDK never offers
          // them: AskUserQuestion (ask before planning), ExitPlanMode (propose
          // the finished plan for approval). Write is included so the model can
          // record its plan to the plan file (the canonical flow that lands a
          // clean plan in ExitPlanMode.plan); the sidecar gate confines Write
          // to the plans directory, so the vault stays read-only. WebSearch /
          // WebFetch let the model research the web while planning — both are
          // read-only, so they pass the plan-mode canUseTool gate and keep the
          // source untouched.
          builtinTools: isPlan
            ? ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Write', 'AskUserQuestion', 'ExitPlanMode']
            : undefined,
          model: overrides?.model ?? activeThreadModel,
          effort: overrides?.effort ?? activeThreadEffort,
          // Only request fast mode when the thread asked for it AND the model
          // supports it — switching to Haiku/Sonnet shouldn't leak a stale
          // fastMode request the SDK would ignore anyway.
          fastMode: activeThreadFastMode && modelSupportsFastMode(activeThreadModel),
          sessionStarted,
          // Interactive surface: open notes the agent creates this run so their
          // inline green/red preview is immediately visible. (Headless ingest
          // leaves this off.) Queue turns can't create notes (no propose_*), so
          // this never fires there.
          navigateToNewNotes: true,
          onSessionStart: () => markSessionStarted(threadId),
          onPart: (part) => {
            buffer.upsert(part)
            // An AskUserQuestion tool part flipping to output-available means
            // the user's answer just came back. Split the turn and drop in the
            // answer bubble — but only when we actually recorded a choice
            // (a bare Skip leaves nothing, so we keep one continuous turn).
            if (
              part.type === 'tool' &&
              part.toolName === 'AskUserQuestion' &&
              part.state === 'output-available' &&
              !rotatedQuestionPartIds.has(part.id)
            ) {
              rotatedQuestionPartIds.add(part.id)
              const qaText = useAnsweredQuestions.getState().take(threadId)
              if (qaText) {
                rotateForAnswer(qaText)
                return
              }
            }
            flusher.schedule()
          },
        })
        // Edit count for the review-comments summarize hook. Sourced from
        // runChat's `editCount` — the number of PendingChanges this run
        // staged (keyed by runId in pendingChangesStore, the single source
        // of truth for chat edits). The old built-in-toolCalls tally is
        // gone: edits no longer round-trip through the run result.
        proposedCount = result.editCount
        appliedCount = result.editCount
        commit('done', result.stopReason)
        setStatus('idle')
        // Completion ping — only fires while the app is unfocused (the user
        // walked away). Best-effort; never blocks the run.
        void notifyJobDone(
          jobTitle,
          result.editCount > 0 ? `${result.editCount} change(s) proposed` : undefined,
        )
      } catch (e) {
        // Errors live on a dedicated turn field, not in the parts timeline —
        // that keeps prompt history (`buildPrompt`) and Copy output clean,
        // and lets the renderer surface the failure with proper error chrome.
        const outcome = classifyRunError(e, { offlineAborted: offline.aborted })
        commit(
          outcome.terminal,
          null,
          outcome.errorText,
          outcome.errorCode,
          outcome.resetsAt,
          outcome.rateLimitType,
          outcome.retryable,
          outcome.overageDisabledReason,
        )
        setStatus(outcome.chatStatus)
        // Ping on a real failure too (not a user-pressed Stop) so a background
        // job that died while you were away doesn't go unnoticed.
        if (outcome.terminal === 'error') {
          void notifyJobDone(jobTitle, outcome.errorText ?? 'Failed')
        }
      } finally {
        offline.dispose()
        endActivity()
      }
    },
    [isQueue, slug, viewingFilePath, selectionText, activeId, activeThreadModel, activeThreadEffort, activeThreadMode, activeThreadFastMode, appendTurn, markSessionStarted, sessionStarted, startActivity, endActivity],
  )

  return { status, streaming, run }
}
