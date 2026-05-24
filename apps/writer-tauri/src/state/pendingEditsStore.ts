// Pending tool-call store for the staged-edit flow (Phase 3.2).
//
// When the sidecar's `canUseTool` hook gates a write-side built-in
// (Edit / Write / MultiEdit / NotebookEdit) it emits a `chat/edit-pending`
// notification. The host's chat runner forwards each one into this
// store keyed by runId, where the ProcessChain UI can pick it up
// and render [Apply] / [Reject] affordances next to the matching
// tool step.
//
// Phase 3.2 keeps this purely a memory store; Apply/Reject are
// wired to the placeholder actions below and don't yet round-trip
// back to the sidecar. Phase 3.3 plugs the missing half — the
// sidecar's canUseTool awaits a host decision channel, and Apply
// resolves it with `behavior: 'allow'`.
//
// Lifecycle:
//   - sidecar emits        → addPending(edit)
//   - user clicks Apply    → markApplied(id) (Phase 3.3: also resolve)
//   - user clicks Reject   → markRejected(id) (Phase 3.3: also resolve)
//   - run finishes / errors → clearForRun(runId)
//
// We never auto-clear from time alone — a long thinking turn could
// validly span minutes, and stale "pending" cards beat a card that
// silently vanishes.

import { create } from 'zustand'

/** One write-side tool call the model attempted, paused at the
 * canUseTool gate awaiting a user decision. `id` is the SDK's
 * toolUseID when available (Phase 3.3) and a client-side UUID
 * otherwise — either way it's stable for the lifetime of the
 * pending edit. */
export interface PendingEdit {
  id: string
  runId: string
  /** Tool name as the SDK reported it (`Edit` / `Write` / etc.). */
  toolName: string
  /** Raw tool input. Shape varies by tool — for Edit/Write the host
   * UI mainly reads `file_path`, `old_string`, `new_string`. */
  input: Record<string, unknown>
  /** ms since epoch when the host received the notification. */
  createdAt: number
  /** User decision once one's been made. Until then `'pending'`. */
  status: 'pending' | 'applied' | 'rejected'
}

interface PendingEditsState {
  /** All pending edits, freshest last. Keyed by id for cheap
   * upsert/update; the ProcessChain UI groups by runId at render. */
  byId: Record<string, PendingEdit>

  /** Record a new pending edit from a sidecar notification. */
  addPending: (edit: Omit<PendingEdit, 'status' | 'createdAt'> & {
    createdAt?: number
  }) => void

  /** Mark the user's decision. Phase 3.2 just flips the status flag;
   * Phase 3.3 will additionally resolve the matching canUseTool
   * Promise so the SDK can proceed. */
  markApplied: (id: string) => void
  markRejected: (id: string) => void

  /** Drop every edit for a run (called on chat:done / chat:error).
   * Edits the user never decided on are dropped silently — they're
   * stale once the turn has ended. */
  clearForRun: (runId: string) => void

  /** Selector helper: list a run's edits ordered by createdAt. */
  forRun: (runId: string) => PendingEdit[]
}

export const usePendingEditsStore = create<PendingEditsState>((set, get) => ({
  byId: {},

  addPending: (edit) => {
    set((s) => ({
      byId: {
        ...s.byId,
        [edit.id]: {
          id: edit.id,
          runId: edit.runId,
          toolName: edit.toolName,
          input: edit.input,
          createdAt: edit.createdAt ?? Date.now(),
          status: 'pending',
        },
      },
    }))
  },

  markApplied: (id) => {
    set((s) => {
      const existing = s.byId[id]
      if (!existing) return s
      return { byId: { ...s.byId, [id]: { ...existing, status: 'applied' } } }
    })
  },

  markRejected: (id) => {
    set((s) => {
      const existing = s.byId[id]
      if (!existing) return s
      return { byId: { ...s.byId, [id]: { ...existing, status: 'rejected' } } }
    })
  },

  clearForRun: (runId) => {
    set((s) => {
      const next: Record<string, PendingEdit> = {}
      for (const [id, edit] of Object.entries(s.byId)) {
        if (edit.runId === runId) continue
        next[id] = edit
      }
      return { byId: next }
    })
  },

  forRun: (runId) => {
    const all = Object.values(get().byId)
    return all
      .filter((e) => e.runId === runId)
      .sort((a, b) => a.createdAt - b.createdAt)
  },
}))
