// App-level, always-on listener for the persistent-query background surface.
// Mounted ONCE at app bootstrap (not per ChatPanel) so a task that completes in
// a thread the user has switched away from is still recorded and its autonomous
// completion turn still lands.
//
// Two responsibilities, both keyed by threadId (never a per-turn runId):
//  1. `claude:task`  → background subagent lifecycle → useBackgroundTasks store
//     (drives the Task-row overlay + any tray).
//  2. `claude:event`/`claude:done`/`claude:error` tagged `background:true` → the
//     AUTONOMOUS completion turn (P2): the model's "task finished" answer that
//     arrives with no active user turn. We stream it through a parser and append
//     it to the thread as a standalone assistant turn (threadsStore.appendTurn),
//     since it isn't anchored to any runChat.
//
// Everything is gated on the thread existing in threadsStore, so headless
// ingest/profile sessions (which reuse the chat sidecar) never accrete entries.

import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { ChatEvent, DoneEvent, ErrorEvent, TaskEvent } from '@/agent/chat/types'
import {
  parseChatEvent,
  parseDoneEvent,
  parseErrorEvent,
  parseTaskEvent,
} from '@/agent/chat/eventSchemas'
import { createStreamParser, type StreamParser } from '@/agent/chat/streamParser'
import { useBackgroundTasks } from '@/stores/backgroundTasks'
import { useThreadsStore } from '@/state/threadsStore'
import type { ChatTurn, MessagePart } from '@/chat/types'

/** In-flight state for one autonomous background turn, keyed by its synthetic
 * runId. Holds the parser + the accumulated parts so we can build a ChatTurn at
 * done. */
interface BgTurn {
  threadId: string
  parser: StreamParser
  parts: Map<string, MessagePart>
  text: string
}

function isKnownThread(threadId: string | undefined): threadId is string {
  return !!threadId && !!useThreadsStore.getState().threads[threadId]
}

/** Mount the app-level background listener. Returns an unlisten to call on
 * teardown (vault switch / app quit). Idempotent per call — mount once. */
export async function mountBackgroundTaskListener(): Promise<UnlistenFn> {
  const bgTurns = new Map<string, BgTurn>()

  const registered = await Promise.all([
    // 1) Background task lifecycle → store.
    listen<TaskEvent>('claude:task', (e) => {
      const p = e.payload
      if (!parseTaskEvent(p) || !isKnownThread(p.threadId)) return
      useBackgroundTasks.getState().ingest(p)
    }),

    // 2a) Autonomous-turn content stream.
    listen<ChatEvent>('claude:event', (e) => {
      const p = e.payload
      if (!parseChatEvent(p) || !p.background || !isKnownThread(p.threadId)) return
      let bg = bgTurns.get(p.runId)
      if (!bg) {
        const state: BgTurn = {
          threadId: p.threadId,
          parts: new Map(),
          text: '',
          parser: createStreamParser({
            onPart: (part) => {
              state.parts.set(part.id, part)
            },
            onTextDelta: (d) => {
              state.text += d
            },
          }),
        }
        bg = state
        bgTurns.set(p.runId, state)
      }
      bg.parser.handleEvent(p.event)
    }),

    // 2b) Autonomous-turn completion → append a standalone assistant turn.
    listen<DoneEvent>('claude:done', (e) => {
      const p = e.payload
      if (!parseDoneEvent(p) || !p.background || !isKnownThread(p.threadId)) return
      const bg = bgTurns.get(p.runId)
      bgTurns.delete(p.runId)
      const parts = bg ? [...bg.parts.values()] : []
      const text = bg?.text ?? ''
      // Nothing renderable (e.g. a purely-internal wake) → skip; the task row
      // overlay already reflects completion.
      if (parts.length === 0 && !text.trim()) return
      const turn: ChatTurn = {
        id: p.runId,
        role: 'assistant',
        content: text,
        ts: Date.now(),
        parts,
        status: 'done',
        stopReason: p.stopReason ?? null,
      }
      void useThreadsStore.getState().appendTurn(p.threadId, turn)
    }),

    // 2c) Autonomous-turn error → drop the in-flight state (no error bubble for
    // a background wake; the task row shows failed/stopped from its notification).
    listen<ErrorEvent>('claude:error', (e) => {
      const p = e.payload
      if (!parseErrorEvent(p) || !p.background) return
      bgTurns.delete(p.runId)
    }),
  ])

  return () => {
    for (const u of registered) {
      try {
        u()
      } catch {
        // best-effort
      }
    }
    bgTurns.clear()
  }
}
