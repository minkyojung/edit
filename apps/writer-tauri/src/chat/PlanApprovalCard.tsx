// Plan-approval card for plan mode (ExitPlanMode).
//
// When the model finishes planning it calls ExitPlanMode, which the sidecar
// gate (C1) parks. This card renders inline: the plan itself is the answer
// text right above it (ExitPlanMode's `plan` input is usually empty), so the
// card is the decision surface — Approve flips the sidecar to 'default' mode
// and lets the model execute via the propose_* relays (each still a Keep/
// Reject card); Revise sends the user's notes back so the model re-plans.

import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  usePendingPermissions,
  type PendingPermission,
} from '@/state/pendingPermissionsStore'
import { cn } from '@/lib/utils'

export function PlanApprovalCard({ pending }: { pending: PendingPermission }) {
  const plan = (pending.input as { plan?: string } | null)?.plan?.trim()
  const [notes, setNotes] = useState('')
  const [sending, setSending] = useState(false)

  async function decide(decision: unknown) {
    if (sending) return
    setSending(true)
    try {
      await invoke('claude_chat_decision', {
        args: { runId: pending.runId, decisionId: pending.decisionId, decision },
      })
    } catch (err) {
      console.error('[PlanApprovalCard] decision failed', err)
      setSending(false)
      return
    }
    usePendingPermissions.getState().clearByRun(pending.runId)
  }

  return (
    <div className="rounded-2xl border border-border/50 bg-muted/40 p-3 text-sm">
      <div className="mb-2 font-medium text-foreground">이 계획대로 진행할까요?</div>
      {plan && (
        <div className="mb-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-xl bg-background/50 p-2 text-xs text-muted-foreground">
          {plan}
        </div>
      )}
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="수정할 점이 있으면 적어주세요 (선택)"
        rows={2}
        className={cn(
          'mb-2 w-full resize-none rounded-xl border border-border/40 bg-background/50 px-2.5 py-1.5',
          'text-sm text-foreground outline-none placeholder:text-muted-foreground',
          'focus-visible:border-foreground/20',
        )}
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() =>
            decide({ type: 'reject', message: notes.trim() || 'Please revise the plan.' })
          }
          disabled={sending}
          className={cn(
            'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
            'text-muted-foreground hover:bg-accent hover:text-foreground',
            'outline-none focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-50',
          )}
        >
          수정 요청
        </button>
        <button
          type="button"
          onClick={() => decide({ type: 'approve' })}
          disabled={sending}
          className={cn(
            'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
            'bg-foreground text-background hover:bg-foreground/90',
            'outline-none focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-50',
          )}
        >
          {sending ? '진행 중…' : '승인'}
        </button>
      </div>
    </div>
  )
}
