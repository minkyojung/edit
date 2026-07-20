// Global listener for the plan-mode interactive gate (canUseTool).
//
// Mounted once by ChatPanel. Listens for `claude:permission` (sidecar parked a
// decision), resolves the owning thread via chatRuns, and records it in
// pendingPermissionsStore so the matching card renders. Clears the pending
// gate when its run finishes (done/error) so a stale card never lingers.
//
// Kept OUT of agent/chat/index.ts on purpose: the runChat module is shared
// with another in-flight refactor, and routing by runId here means we don't
// need to touch its per-run listener block.

import { useEffect } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { parseDoneEvent, parseErrorEvent } from '@/agent/chat/eventSchemas'
import { useChatRuns } from '@/stores/chatRuns'
import { usePendingPermissions } from '@/state/pendingPermissionsStore'

interface PermissionPayload {
  runId: string
  decisionId: string
  toolName: string
  input: unknown
}

export function usePermissionGate(): void {
  useEffect(() => {
    const unlistens: UnlistenFn[] = []
    let disposed = false
    Promise.all([
      listen<PermissionPayload>('claude:permission', (e) => {
        const { runId, decisionId, toolName, input } = e.payload
        const threadId = useChatRuns.getState().runs.get(runId)?.threadId
        if (!threadId) return
        usePendingPermissions.getState().set({ runId, threadId, decisionId, toolName, input })
      }),
      // Clear on run end so a card never outlives its turn. A resolved gate
      // is also cleared at answer time by the card itself; this is the
      // backstop for cancel / error / done-without-answer.
      listen<{ runId: string }>('claude:done', (e) => {
        if (!parseDoneEvent(e.payload)) return
        usePendingPermissions.getState().clearByRun(e.payload.runId)
      }),
      listen<{ runId: string }>('claude:error', (e) => {
        if (!parseErrorEvent(e.payload)) return
        usePendingPermissions.getState().clearByRun(e.payload.runId)
      }),
    ]).then((registered) => {
      if (disposed) {
        registered.forEach((fn) => fn())
        return
      }
      unlistens.push(...registered)
    })
    return () => {
      disposed = true
      unlistens.forEach((fn) => fn())
    }
  }, [])
}
