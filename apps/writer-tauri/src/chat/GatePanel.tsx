// Unified slot for plan-mode interactive gates. Whenever a gate is parked
// (a clarifying question or a plan approval), this takes the prompt input's
// place and routes to the right inner panel by tool. ChatPanel toggles
// `GatePanel ↔ PromptInput`, so the decision surface always sits in the same
// spot regardless of the gate type. `onClose` (✕) stops the turn.

import type { PendingPermission } from '@/state/pendingPermissionsStore'
import { QuestionPanel } from '@/chat/QuestionPanel'
import { PlanApprovalCard } from '@/chat/PlanApprovalCard'

export function GatePanel({
  pending,
  onClose,
}: {
  pending: PendingPermission
  onClose: () => void
}) {
  if (pending.toolName === 'AskUserQuestion') {
    return <QuestionPanel pending={pending} onClose={onClose} />
  }
  if (pending.toolName === 'ExitPlanMode') {
    return <PlanApprovalCard pending={pending} onClose={onClose} />
  }
  return null
}
