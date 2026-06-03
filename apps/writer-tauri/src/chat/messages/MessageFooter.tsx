import { IconAlertTriangle } from '@tabler/icons-react'
import type { ChatTurn } from '@/chat/types'
import { CopyButton } from '@/chat/messages/CopyButton'
import { RegenerateButton } from '@/chat/messages/RegenerateButton'
import { FileToWikiButton } from '@/chat/messages/FileToWikiButton'

/** Action row that hangs under a normal (non-error, non-stopped)
 * assistant turn. Surfaces wall-clock duration, abnormal stop-reason
 * warnings, copy / regenerate / file-to-wiki actions. Returns `null`
 * when none of the slots have content to show — the parent doesn't
 * need to gate the render itself.
 *
 * `threadId` / `threadTitle` enable the file-to-wiki action; absent
 * (chat panel before a thread is active) the button hides. */
export function MessageFooter({
  turn,
  durationLabel,
  stopReasonLabel,
  canCopy,
  canRegenerate,
  onRegenerate,
  threadId,
  threadTitle,
}: {
  turn: ChatTurn
  durationLabel: string | null
  stopReasonLabel: string | null
  canCopy: boolean
  canRegenerate: boolean
  onRegenerate?: (turnId: string) => void
  threadId?: string | null
  threadTitle?: string
}) {
  const canFileToWiki = canCopy && !!threadId
  if (
    !durationLabel &&
    !stopReasonLabel &&
    !canCopy &&
    !canRegenerate &&
    !canFileToWiki
  ) {
    return null
  }
  return (
    <div className="mt-1 flex items-center gap-1.5 text-[13px]">
      {stopReasonLabel && (
        <span className="inline-flex items-center gap-1 text-warning">
          <IconAlertTriangle size={12} />
          <span>{stopReasonLabel}</span>
        </span>
      )}
      {durationLabel && (
        <span className="text-muted-foreground/70">
          {stopReasonLabel ? `· ${durationLabel}` : durationLabel}
        </span>
      )}
      {canCopy && <CopyButton text={turn.content} />}
      {canFileToWiki && (
        <FileToWikiButton
          text={turn.content}
          threadId={threadId!}
          threadTitle={threadTitle ?? ''}
        />
      )}
      {canRegenerate && <RegenerateButton onClick={() => onRegenerate!(turn.id)} />}
    </div>
  )
}
