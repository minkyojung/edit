import { IconAlertTriangle } from '@tabler/icons-react'
import type { ChatTurn } from '@/chat/types'
import { CopyButton } from '@/chat/messages/CopyButton'
import { RegenerateButton } from '@/chat/messages/RegenerateButton'

/** Action row that hangs under a normal (non-error, non-stopped)
 * assistant turn. Surfaces wall-clock duration, abnormal stop-reason
 * warnings, and the copy / regenerate buttons. Returns `null` when
 * none of the slots have content to show — the parent doesn't need
 * to gate the render itself. */
export function MessageFooter({
  turn,
  durationLabel,
  stopReasonLabel,
  canCopy,
  canRegenerate,
  onRegenerate,
}: {
  turn: ChatTurn
  durationLabel: string | null
  stopReasonLabel: string | null
  canCopy: boolean
  canRegenerate: boolean
  onRegenerate?: (turnId: string) => void
}) {
  if (!durationLabel && !stopReasonLabel && !canCopy && !canRegenerate) return null
  return (
    <div className="mt-1 flex items-center gap-1.5 text-xs">
      {stopReasonLabel && (
        <span className="inline-flex items-center gap-1 text-warning">
          <IconAlertTriangle size={10} />
          <span>{stopReasonLabel}</span>
        </span>
      )}
      {durationLabel && (
        <span className="text-muted-foreground/70">
          {stopReasonLabel ? `· ${durationLabel}` : durationLabel}
        </span>
      )}
      {canCopy && <CopyButton text={turn.content} />}
      {canRegenerate && <RegenerateButton onClick={() => onRegenerate!(turn.id)} />}
    </div>
  )
}
