// Plan-approval panel for plan mode (ExitPlanMode).
//
// Rendered by GatePanel in the prompt input's place (same slot as the
// question panel). The plan itself is the answer text above in the
// transcript; this panel is the decision surface — Approve flips the sidecar
// to 'default' and lets the model execute via propose_* (each edit still a
// Keep/Reject card); Revise sends the user's notes back to re-plan; ✕ stops
// the turn (reuses the host abort path, same as the question panel).

import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { IconX } from '@tabler/icons-react'
import {
  usePendingPermissions,
  type PendingPermission,
} from '@/state/pendingPermissionsStore'
import { cn } from '@/lib/utils'

interface Props {
  pending: PendingPermission
  /** Stop the turn (✕). Reuses the host abort path. */
  onClose: () => void
}

export function PlanApprovalCard({ pending, onClose }: Props) {
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
    <div className="rounded-3xl border border-border/40 bg-muted p-3 text-sm">
      {/* Header: prompt + close */}
      <div className="mb-2 flex items-start justify-between gap-3 px-1">
        <div className="font-medium text-foreground">이 계획대로 진행할까요?</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="닫기 (턴 중지)"
          className="shrink-0 rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <IconX size={16} />
        </button>
      </div>

      {/* The plan itself is the assistant's answer text in the transcript —
          this panel is the decision surface only. */}
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

      <div className="flex justify-end gap-2 px-1">
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
