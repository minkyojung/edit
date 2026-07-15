import { IconAlertTriangle } from '@tabler/icons-react'
import type { ChatTurn } from '@/chat/types'
import { CopyButton } from '@/chat/messages/CopyButton'
import { FileToWikiButton } from '@/chat/messages/FileToWikiButton'

/** Action row that hangs under a normal (non-error, non-stopped)
 * assistant turn. Surfaces wall-clock duration, abnormal stop-reason
 * warnings, copy / file-to-wiki actions. Returns `null` when none of the
 * slots have content to show — the parent doesn't need to gate the render
 * itself.
 *
 * No regenerate action here: re-running a settled, successful answer
 * discards it from the UI while it stays in the SDK session, so the model
 * would still see the dropped answer on resume. Recovery from a failed /
 * stopped / empty turn (which never committed a real answer) keeps its
 * retry affordance — see ErrorCard and TerminalNote.
 *
 * `threadId` / `threadTitle` enable the file-to-wiki action; absent
 * (chat panel before a thread is active) the button hides. */
export function MessageFooter({
  turn,
  durationLabel,
  stopReasonLabel,
  canCopy,
  threadId,
  threadTitle,
}: {
  turn: ChatTurn
  durationLabel: string | null
  stopReasonLabel: string | null
  canCopy: boolean
  threadId?: string | null
  threadTitle?: string
}) {
  const canFileToWiki = canCopy && !!threadId
  if (!durationLabel && !stopReasonLabel && !canCopy && !canFileToWiki) {
    return null
  }
  return (
    <div className="mt-1 flex items-center gap-1.5 text-body">
      {stopReasonLabel && (
        <span className="inline-flex items-center gap-1 text-warning">
          <IconAlertTriangle size={14} />
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
    </div>
  )
}
