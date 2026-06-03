// Plan-mode interactive gates awaiting a user decision, keyed by runId.
//
// The sidecar parks an ExitPlanMode / AskUserQuestion call and emits
// `claude:permission`; the global gate listener (usePermissionGate) records
// it here, the matching card renders in the transcript, and the user's choice
// goes back via `claude_chat_decision`. In-memory only — a pending gate is
// transient turn state, cleared on answer or when the run ends.

import { create } from 'zustand'

export interface PendingPermission {
  /** The run this gate belongs to (from chatRuns) — used to send the
   * decision back and to clear on run end. */
  runId: string
  /** Owning thread, resolved from chatRuns at arrival — drives which
   * thread's transcript renders the card. */
  threadId: string
  /** Sidecar-minted id correlating this gate with its decision. */
  decisionId: string
  /** 'ExitPlanMode' | 'AskUserQuestion'. */
  toolName: string
  /** Raw tool input: `{ questions }` for AskUserQuestion, `{ plan }` for
   * ExitPlanMode (often empty — the plan lives in the answer text). */
  input: unknown
}

interface PendingPermissionsState {
  byRun: Record<string, PendingPermission>
  set: (p: PendingPermission) => void
  clearByRun: (runId: string) => void
}

export const usePendingPermissions = create<PendingPermissionsState>((set) => ({
  byRun: {},
  set: (p) => set((s) => ({ byRun: { ...s.byRun, [p.runId]: p } })),
  clearByRun: (runId) =>
    set((s) => {
      if (!(runId in s.byRun)) return s
      const next = { ...s.byRun }
      delete next[runId]
      return { byRun: next }
    }),
}))
