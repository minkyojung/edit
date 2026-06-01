import React from 'react'
import type { ChatTurn } from '@/chat/types'
import { formatDuration } from '@/chat/utils/formatDuration'
import { describeStopReason } from '@/chat/utils/errorMessage'
import { ActivityStatus, activityLabel } from '@/chat/parts/ActivityStatus'
import { PartList } from '@/chat/parts/PartList'
import { ThinkingPanel } from '@/chat/parts/ReasoningPart'
import { StreamingMarkdown } from '@/chat/ui/StreamingMarkdown'
import { StoppedCard } from '@/chat/messages/StoppedCard'
import { ErrorCard } from '@/chat/messages/ErrorCard'
import { MessageFooter } from '@/chat/messages/MessageFooter'

export const MessageRow = React.memo(function MessageRow({
  turn,
  threadId,
  threadTitle,
  onRegenerate,
  hideText = false,
}: {
  turn: ChatTurn
  /** Active thread id — needed by the file-to-wiki action so the
   * enqueued proposals carry their originating thread as `sourceSlug`.
   * Null when no thread is active (the footer hides the action). */
  threadId?: string | null
  /** Active thread title — surfaces as `chat: <title>` on enqueued
   * proposals. */
  threadTitle?: string
  /** Provided only when this turn is the latest settled assistant turn —
   * the only one Regenerate is allowed on. */
  onRegenerate?: (turnId: string) => void
  /** Suppress the answer text — set for a parked plan turn whose plan is
   * shown in the approval card, so it isn't duplicated in the transcript. */
  hideText?: boolean
}) {
  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-3xl bg-info/15 px-3 py-2 text-[14px] text-foreground">
          {turn.content}
        </div>
      </div>
    )
  }
  const hasThinking = !!turn.thinking && turn.thinking.trim().length > 0
  const hasText = turn.content.trim().length > 0
  const isStreaming = turn.status === 'streaming'
  const isStopped = turn.status === 'stopped'
  const isError = turn.status === 'error'

  // The activity line stays up until the user-facing text answer starts —
  // its label changes (Thinking… → Suggesting an edit… → …) as tools fire,
  // but it always sits in the same slot. We suppress it when the only
  // active label would be "Thinking…" AND the reasoning panel is already
  // visible (which has its own Thinking… spinner) — otherwise the user
  // sees two identical indicators stacked.
  const hasTextAnswer = turn.parts
    ? turn.parts.some((p) => p.type === 'text' && p.text.length > 0)
    : hasText
  const reasoningVisible =
    turn.parts?.some((p) => p.type === 'reasoning' && p.text.length > 0) ?? false
  const activityCurrentLabel = activityLabel(turn.parts)
  const showActivity =
    isStreaming &&
    !hasTextAnswer &&
    !(reasoningVisible && activityCurrentLabel === 'Thinking…')

  // Two render paths:
  // - Legacy turns (no `parts`): keep the original text+thinking layout.
  // - Parts-aware turns: walk the timeline so tool calls / reasoning blocks
  //   appear inline at the moment they happened.
  const body = (
    <div className="text-[14px] text-foreground leading-relaxed">
      {showActivity && <ActivityStatus parts={turn.parts} />}
      {turn.parts && turn.parts.length > 0 ? (
        <PartList parts={turn.parts} isStreaming={isStreaming} hideText={hideText} />
      ) : (
        <>
          {hasThinking && (
            <ThinkingPanel content={turn.thinking!} streamingNoText={isStreaming && !hasText} />
          )}
          {hasText && !hideText && (
            <StreamingMarkdown content={turn.content} isStreaming={isStreaming} />
          )}
        </>
      )}
    </div>
  )

  // Duration footer — wall-clock time the user waited. Only shown after the
  // turn settled (avoid a live ticker that fights the streaming animation).
  const durationLabel =
    !isStreaming && typeof turn.durationMs === 'number' ? formatDuration(turn.durationMs) : null
  // Abnormal stop reasons get surfaced explicitly so the user knows when an
  // answer was cut off, paused, or refused — `end_turn` / `stop_sequence` /
  // `tool_use` are routine and stay hidden.
  const stopReasonLabel = !isStreaming ? describeStopReason(turn.stopReason) : null

  // Copy is offered once the turn has produced final text and is no longer
  // streaming — copying mid-stream would clip the answer.
  const canCopy = !isStreaming && hasText
  const canRegenerate = !isStreaming && !!onRegenerate

  if (isStopped) {
    return (
      <StoppedCard
        turn={turn}
        body={body}
        hasText={hasText}
        durationLabel={durationLabel}
        onRegenerate={onRegenerate}
      />
    )
  }

  if (isError) {
    return (
      <ErrorCard
        turn={turn}
        body={body}
        hasText={hasText}
        hasThinking={hasThinking}
        durationLabel={durationLabel}
        onRegenerate={onRegenerate}
      />
    )
  }

  return (
    <>
      {body}
      <MessageFooter
        turn={turn}
        durationLabel={durationLabel}
        stopReasonLabel={stopReasonLabel}
        canCopy={canCopy}
        canRegenerate={canRegenerate}
        onRegenerate={onRegenerate}
        threadId={threadId}
        threadTitle={threadTitle}
      />
    </>
  )
})
