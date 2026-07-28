// Single source of truth for background subagent tasks on the persistent-query
// path. Lives outside React (like chatRuns) and is keyed by threadId → taskId,
// so a task_started in one turn is updated by a task_notification in a LATER
// turn — the key is the taskId, never a per-turn runId. Fed by the app-level
// backgroundTaskListener from the `claude:task` channel; read by TaskActivity
// (row overlay) and any tray surface.

import { create } from 'zustand'
import type { TaskEvent } from '@/agent/chat/types'

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped'

export interface BackgroundTask {
  taskId: string
  threadId: string
  /** Subagent role name (e.g. 'researcher'), when the task is a Task subagent. */
  subagentType?: string
  description?: string
  status: BackgroundTaskStatus
  /** Optimistic latch set the instant the user hits Stop, before the confirming
   * task_notification('stopped') arrives. */
  stopping?: boolean
  // Live heartbeat (task_progress).
  toolUses?: number
  totalTokens?: number
  lastTool?: string
  summary?: string
  // Completion (task_notification).
  resultSummary?: string
  outputFile?: string
  /** False until the user has seen the terminal state — drives a "needs
   * attention" tray. */
  acknowledged?: boolean
  startedAt: number
  updatedAt: number
}

function nowMs(): number {
  return Date.now()
}

/** Map a wire status onto a terminal display status, or undefined if the task
 * is still running.
 *
 * `killed` maps onto `stopped`: the SDK uses it for a task torn down rather
 * than finished (notably a background subagent severed by an interrupt), and
 * the sidecar already treats it as terminal. Omitting it here left the row
 * spinning forever for a task everything else considered over. */
function terminalFromStatus(status?: string): BackgroundTaskStatus | undefined {
  if (status === 'completed' || status === 'failed' || status === 'stopped') return status
  if (status === 'killed') return 'stopped'
  return undefined
}

interface BackgroundTasksStore {
  /** threadId → taskId → task. */
  byThread: Record<string, Record<string, BackgroundTask>>
  /** Ingest one `claude:task` event (idempotent, order-independent). */
  ingest: (e: TaskEvent) => void
  /** Mark a thread's terminal tasks as seen (clears the tray). */
  ack: (threadId: string, taskId?: string) => void
  /** Drop all tasks for a thread (archive / delete / vault switch). */
  clearThread: (threadId: string) => void
}

export const useBackgroundTasks = create<BackgroundTasksStore>((set) => ({
  byThread: {},
  ingest: (e) => {
    if (!e.taskId) return // 'changed' housekeeping carries no id — nothing to store
    set((s) => {
      const thread = s.byThread[e.threadId] ?? {}
      const prev = thread[e.taskId!]
      const base: BackgroundTask = prev ?? {
        taskId: e.taskId!,
        threadId: e.threadId,
        status: 'running',
        startedAt: nowMs(),
        updatedAt: nowMs(),
      }
      const patchStatus =
        e.kind === 'notification'
          ? (terminalFromStatus(e.status) ?? base.status)
          : (terminalFromStatus(e.patch?.status) ?? base.status)
      const next: BackgroundTask = {
        ...base,
        subagentType: e.subagentType ?? base.subagentType,
        description: e.description ?? base.description,
        toolUses: e.toolUses ?? base.toolUses,
        totalTokens: e.totalTokens ?? base.totalTokens,
        lastTool: e.lastTool ?? base.lastTool,
        summary: e.summary ?? base.summary,
        status: patchStatus,
        stopping: patchStatus !== 'running' ? false : base.stopping,
        updatedAt: nowMs(),
      }
      if (e.kind === 'notification') {
        next.resultSummary = e.summary ?? next.resultSummary
        next.outputFile = e.outputFile ?? next.outputFile
        next.acknowledged = false // relight the tray on a fresh terminal
      }
      return { byThread: { ...s.byThread, [e.threadId]: { ...thread, [e.taskId!]: next } } }
    })
  },
  ack: (threadId, taskId) => {
    set((s) => {
      const thread = s.byThread[threadId]
      if (!thread) return s
      const nextThread: Record<string, BackgroundTask> = {}
      for (const [id, t] of Object.entries(thread)) {
        nextThread[id] = taskId && id !== taskId ? t : { ...t, acknowledged: true }
      }
      return { byThread: { ...s.byThread, [threadId]: nextThread } }
    })
  },
  clearThread: (threadId) => {
    set((s) => {
      if (!s.byThread[threadId]) return s
      const next = { ...s.byThread }
      delete next[threadId]
      return { byThread: next }
    })
  },
}))
