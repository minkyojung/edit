// Streaming chat runner entry point — drives a single chat turn
// through the Tauri sidecar. The sidecar wraps Anthropic's Agent
// SDK (`query()`), which internally handles tool execution; we
// only consume the resulting notifications:
//
//   claude:event    → assistant text blocks (accumulated, emitted
//                     as deltas)
//   claude:proposal → propose_change payload (we apply the mark
//                     locally)
//   claude:done     → end of turn
//   claude:error    → upstream failure or cancellation
//
// V1 multi-turn handling: only the latest user message is sent;
// session resumption (via the SDK's `resume` option) keeps prior
// turns server-side.

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { FREE_CHAT_PROMPT } from '../skills/freeChat'
import { assembleContext } from '@/agent/contextPipeline'
import { getActiveVaultPath } from '@/state/settingsStore'
import { useChatRuns } from '@/stores/chatRuns'
import {
  agentIdForModel,
  DEFAULT_MODEL,
  type ChatErrorRateLimit,
  type ChatEvent,
  type DoneEvent,
  type ErrorEvent,
  type ProposalEvent,
  type RunChatArgs,
  type RunChatResult,
  type ToolCallRecord,
} from './types'
import {
  buildUserPrompt,
  composeSystemBlocks,
  shouldResumeSession,
  truncateDocForPrompt,
} from './systemPrompt'
import { createStreamParser } from './streamParser'
import { createProposalListener } from './proposalListener'

export async function runChat(args: RunChatArgs): Promise<RunChatResult> {
  const {
    view,
    // ydoc is intentionally not destructured: the proposal listener now
    // looks up the live ydoc via useDocsStore by slug, since the
    // captured ydoc could be destroyed by closeDoc while a run is
    // in flight. Keeping ydoc in RunChatArgs preserves the call-site
    // shape so existing callers (useChatRunner) need no change.
    slug,
    threadId,
    history,
    prompt: promptOverride,
    systemPrompt,
    model = DEFAULT_MODEL,
    effort: effortOverride,
    relayTools = ['propose_change', 'read_page', 'search_wiki'],
    appendDocument = true,
    signal,
    onTextDelta,
    onThinkingDelta,
    onPart,
    onToolApplied,
    sessionStarted,
  } = args
  const agentId = agentIdForModel(model)

  // Effort default: Haiku is the copyeditor lane (short, latency-
  // sensitive turns) → 'low'. Sonnet/Opus are the chat lane → 'medium'.
  // Caller's explicit choice always wins.
  const effort: 'low' | 'medium' | 'high' =
    effortOverride ?? (model.includes('haiku') ? 'low' : 'medium')

  const docText = view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n')
  const docForPrompt = truncateDocForPrompt(docText)
  const systemBody = systemPrompt ?? FREE_CHAT_PROMPT
  const prompt = promptOverride ?? buildUserPrompt(history ?? [])

  // Tier 1/2 + conventions via the assembleContext facade. Pass both
  // the user message and the current doc body so wikilinks in either
  // surface trigger hot-page inclusion. Failures upstream collapse to
  // empty fields — chat never blocks on the context round-trip.
  const ctx = await assembleContext({
    text: prompt,
    docBody: docForPrompt,
  })

  const system = composeSystemBlocks({
    docForPrompt,
    systemBody,
    ctx,
    appendDocument,
  })
  const runId = crypto.randomUUID()

  // Internal controller is the single source of abort — it bridges the
  // (optional) caller-supplied signal AND the central chatRuns registry,
  // so an abort from either side fans out the same way.
  const controller = new AbortController()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  const runs = useChatRuns.getState()
  runs.start(threadId, runId, controller, slug)

  const toolCalls: ToolCallRecord[] = []

  // Live stream → MessagePart translator. Owns the timeline state
  // (partsById, blockIndexToPartId, etc.) so this file only sees
  // the entry points it actually drives.
  const parser = createStreamParser({ onPart, onTextDelta, onThinkingDelta })

  const unlistens: UnlistenFn[] = []
  const cleanup = () => {
    useChatRuns.getState().end(runId)
    while (unlistens.length > 0) {
      const u = unlistens.pop()
      try {
        u?.()
      } catch {
        // listeners are best-effort; an already-detached one is fine
      }
    }
  }

  const finished = new Promise<RunChatResult>((resolve, reject) => {
    let settled = false
    const settleOk = (stopReason: string | null) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ stopReason, toolCalls })
    }
    const settleErr = (err: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    Promise.all([
      listen<ChatEvent>('claude:event', (e) => {
        if (e.payload.runId !== runId) return
        parser.handleEvent(e.payload.event)
      }),
      listen<ProposalEvent>(
        'claude:proposal',
        createProposalListener({
          runId,
          slug,
          agentId,
          toolCalls,
          parser,
          onToolApplied,
        }),
      ),
      listen<DoneEvent>('claude:done', (e) => {
        if (e.payload.runId !== runId) return
        settleOk(e.payload.stopReason)
      }),
      listen<ErrorEvent>('claude:error', (e) => {
        if (e.payload.runId !== runId) return
        if (e.payload.code === 'CANCELLED') {
          settleErr(new DOMException(e.payload.message, 'AbortError'))
        } else {
          const err = new Error(`${e.payload.code}: ${e.payload.message}`)
          // For rate-limit failures, attach the most recent SDK
          // rate_limit snapshot so the renderer can drive a precise
          // countdown. The info travels as a non-enumerable
          // property to keep `Error` serialization predictable.
          const rateLimitInfo = parser.rateLimitInfo()
          if (e.payload.code === 'RATE_LIMIT' && rateLimitInfo) {
            // SDK reports `resetsAt` in seconds since epoch. The UI
            // side works in ms (Date.now() math) so we normalize at
            // the boundary.
            const resetsAtSec = rateLimitInfo.resetsAt
            ;(err as Error & { rateLimit?: ChatErrorRateLimit }).rateLimit = {
              resetsAt: typeof resetsAtSec === 'number' ? resetsAtSec * 1000 : undefined,
              rateLimitType: rateLimitInfo.rateLimitType,
            }
          }
          settleErr(err)
        }
      }),
      // Sidecar process death. The Rust supervisor emits this on
      // child exit (before attempting restart). Without it, in-flight
      // runs hang waiting on chat:event / chat:done that will never
      // arrive — the producer is gone. We settle as a regular error
      // so the UI shows a retry card.
      listen<{ mode: string }>('sidecar:died', (e) => {
        if (e.payload.mode !== 'chat') return
        settleErr(new Error('SIDECAR_DIED: chat sidecar crashed'))
      }),
    ])
      .then((registered) => {
        unlistens.push(...registered)
      })
      .catch((err) => settleErr(err))

    if (controller.signal.aborted) {
      invoke('claude_chat_cancel', { args: { runId } }).catch(() => {})
      settleErr(new DOMException('aborted', 'AbortError'))
      return
    }
    controller.signal.addEventListener('abort', () => {
      invoke('claude_chat_cancel', { args: { runId } }).catch(() => {})
      // The CANCELLED chat:error notification will arrive and finalize.
    })
  })

  // Map our threadId 1:1 to the SDK's session UUID. First turn of a
  // thread creates the session via `sessionId`; later turns load it
  // via `resume`. Doing both at once is invalid (without forkSession)
  // so we pick exactly one based on whether an assistant has spoken
  // yet. Persisted server-side under ~/.claude/projects/ so the
  // session survives app restarts.
  const isResume = shouldResumeSession(history, sessionStarted)
  try {
    await invoke('claude_chat_start', {
      args: {
        runId,
        model,
        systemPrompt: system,
        prompt,
        relayTools,
        // Forwarded so sidecar's read_page / search_wiki handlers
        // can resolve vault-relative paths against the user's chosen
        // folder. Undefined when no vault selected — the sidecar
        // then skips registering filesystem tools (warns once).
        vaultPath: getActiveVaultPath() ?? undefined,
        effort,
        sessionId: isResume ? undefined : threadId,
        resume: isResume ? threadId : undefined,
      },
    })
  } catch (e) {
    cleanup()
    throw e
  }

  return finished
}
