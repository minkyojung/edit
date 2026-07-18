// Generic "wait for a Claude run to finish, capturing the structured
// tool output along the way" primitive. Originally lived inside
// ingest.ts; lifted out so the Profile bootstrap pipeline (and any
// future consumer) can reuse the same listener choreography without
// duplicating event wiring.
//
// The shape of each run is identical:
//   1. claude_chat_start kicks off the SDK with relayTools.
//   2. The model emits text deltas (`claude:event`) which we
//      concatenate, AND it calls the structured-output tool exactly
//      once which the sidecar forwards as a custom notification.
//   3. `claude:done` settles the promise; `claude:error` or
//      `sidecar:died` reject.
//
// Callers parameterise the result event name (e.g. `ingest:result`
// or `profile:result`) and the expected `TInput` shape; everything
// else is fixed.

import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  parseChatEvent,
  parseDoneEvent,
  parseErrorEvent,
} from '@/agent/chat/eventSchemas'

export interface ChatRunOutcome<TInput> {
  /** Structured output emitted via the run's relay tool. Null when
   * the model finished without calling the tool (malformed result —
   * caller decides whether to retry / soft-fail). */
  toolInput: TInput | null
  /** Concatenated assistant text seen during the run. Useful for
   * debugging when the tool wasn't called. */
  text: string
}

/** Resolve when the Claude run identified by `runId` finishes; reject
 * on transport / sidecar errors. The structured-output event the
 * caller is waiting on is named by `resultEventName` (e.g.
 * `ingest:result`, `profile:result`) — the sidecar emits it from
 * inside whichever relay tool was registered for the run. */
export function awaitChatRun<TInput>(
  runId: string,
  resultEventName: string,
): Promise<ChatRunOutcome<TInput>> {
  return new Promise<ChatRunOutcome<TInput>>((resolve, reject) => {
    let toolInput: TInput | null = null
    let assistantText = ''
    const unlistens: UnlistenFn[] = []
    let settled = false

    const cleanup = () => {
      while (unlistens.length > 0) {
        try {
          unlistens.pop()?.()
        } catch {
          /* listener already detached */
        }
      }
    }
    const settleOk = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ toolInput, text: assistantText })
    }
    const settleErr = (err: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    Promise.all([
      listen<{ runId: string; input: TInput }>(resultEventName, (e) => {
        if (e.payload.runId !== runId) return
        toolInput = e.payload.input
      }),
      listen<{
        runId: string
        event: {
          type?: string
          event?: {
            type?: string
            delta?: { type?: string; text?: string }
          }
          message?: { content?: Array<{ type: string; text?: string }> }
        }
      }>('claude:event', (e) => {
        if (!parseChatEvent(e.payload) || e.payload.runId !== runId) return
        const ev = e.payload.event
        if (ev?.type === 'stream_event') {
          const inner = ev.event
          if (
            inner?.type === 'content_block_delta' &&
            inner.delta?.type === 'text_delta' &&
            inner.delta.text
          ) {
            assistantText += inner.delta.text
          }
          return
        }
        if (ev?.type === 'assistant') {
          const blocks = ev.message?.content ?? []
          if (Array.isArray(blocks) && assistantText.length === 0) {
            for (const b of blocks) {
              if (b.type === 'text' && typeof b.text === 'string') {
                assistantText += b.text
              }
            }
          }
        }
      }),
      listen<{ runId: string; stopReason: string | null }>(
        'claude:done',
        (e) => {
          if (!parseDoneEvent(e.payload) || e.payload.runId !== runId) return
          settleOk()
        },
      ),
      listen<{ runId: string; code: string; message: string }>(
        'claude:error',
        (e) => {
          if (!parseErrorEvent(e.payload) || e.payload.runId !== runId) return
          settleErr(new Error(`${e.payload.code}: ${e.payload.message}`))
        },
      ),
      listen<{ mode: string }>('sidecar:died', (e) => {
        if (e.payload.mode !== 'chat') return
        settleErr(new Error('SIDECAR_DIED: chat sidecar crashed'))
      }),
    ])
      .then((registered) => unlistens.push(...registered))
      .catch((err) => settleErr(err))
  })
}
