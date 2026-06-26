import React, { useEffect, useState } from 'react'
import {
  IconAlertTriangle,
  IconFile,
  IconFileText,
  IconFileTypePdf,
  IconPhoto,
  IconPlayerStopFilled,
} from '@tabler/icons-react'
import type { Attachment, ChatTurn } from '@/chat/types'
import { formatDuration } from '@/chat/utils/formatDuration'
import { describeStopReason } from '@/chat/utils/errorMessage'
import { ChatRunningIcon } from '@/components/icons/ChatRunningIcon'
import { PartList } from '@/chat/parts/PartList'
import { ThinkingPanel } from '@/chat/parts/ReasoningPart'
import { StreamingMarkdown } from '@/chat/ui/StreamingMarkdown'
import { TerminalNote } from '@/chat/messages/TerminalNote'
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
    const fileAtts = (turn.attachments ?? []).filter(
      (a): a is Extract<Attachment, { type: 'file' }> => a.type === 'file',
    )
    return (
      <div className="flex justify-end">
        {/* `synthetic` answer bubbles carry a multi-line "Q:/A:" summary —
            preserve their line breaks (normal typed messages keep the
            single-line treatment). */}
        <div
          className={`max-w-[85%] rounded-lg bg-muted px-4 py-2.5 text-[15px] text-foreground${
            turn.synthetic ? ' whitespace-pre-line' : ''
          }`}
        >
          {fileAtts.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {fileAtts.map((att, i) => (
                <FileChip key={i} name={att.name} mediaType={att.mediaType} />
              ))}
            </div>
          )}
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

  // Two render paths:
  // - Legacy turns (no `parts`): keep the original text+thinking layout.
  // - Parts-aware turns (and ANY streaming turn): walk the timeline so the
  //   process group / tool / reasoning rows appear inline as they happen. The
  //   group's own header carries the live "working" status now, so there's no
  //   separate activity line.
  const body = (
    <div className="text-[15px] text-foreground leading-relaxed">
      {(turn.parts && turn.parts.length > 0) || isStreaming ? (
        <PartList parts={turn.parts ?? []} isStreaming={isStreaming} hideText={hideText} />
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
  // A settled, non-error/stopped turn that produced nothing — no text, no
  // thinking, no parts. Without an explicit marker it renders as a blank gap
  // (the body div collapses and MessageFooter has nothing to show), which
  // reads as a broken turn. Surface it as "No response" + Regenerate.
  const isEmptyDone =
    !isStreaming &&
    !isError &&
    !isStopped &&
    !hasText &&
    !hasThinking &&
    !(turn.parts && turn.parts.length > 0)

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
      {/* While streaming, the bottom of the turn shows a live elapsed timer;
          when it settles, that slot becomes the footer (final duration +
          actions). Stopped / empty turns settle into a borderless TerminalNote
          — only real errors get the boxed ErrorCard. */}
      {isStreaming ? (
        <StreamingTimer startedAt={turn.ts} />
      ) : isStopped ? (
        <TerminalNote
          icon={<IconPlayerStopFilled size={12} stroke={0} className="opacity-70" />}
          label="Stopped"
          durationLabel={durationLabel}
          copyText={canCopy ? turn.content : undefined}
          onRegenerate={canRegenerate ? () => onRegenerate?.(turn.id) : undefined}
        />
      ) : isEmptyDone ? (
        // Warning tier: the turn settled but produced no usable answer. Label
        // from the stop reason when it explains why (Refused / cut off /
        // Paused); otherwise a plain "No response". Amber, not a red error
        // card — the request didn't fail, it just came back empty.
        <TerminalNote
          tone="warning"
          icon={<IconAlertTriangle size={14} className="opacity-70" />}
          label={stopReasonLabel ?? 'No response'}
          durationLabel={durationLabel}
          onRegenerate={canRegenerate ? () => onRegenerate?.(turn.id) : undefined}
        />
      ) : (
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
      )}
    </>
  )
})

function FileChip({ name, mediaType }: { name: string; mediaType: string }) {
  const Icon = mediaType.startsWith('image/')
    ? IconPhoto
    : mediaType === 'application/pdf'
      ? IconFileTypePdf
      : mediaType.startsWith('text/')
        ? IconFileText
        : IconFile
  return (
    <div className="flex items-center gap-1 rounded-md bg-background/50 px-2 py-1 text-footnote text-muted-foreground">
      <Icon size={12} stroke={1.5} className="shrink-0" />
      <span className="max-w-[140px] truncate">{name}</span>
    </div>
  )
}

/** Live elapsed-time readout at the bottom of a streaming turn — ticks in
 * tenths; once the turn settles, the MessageFooter takes this slot with the
 * final whole-second duration + actions. */
function StreamingTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(id)
  }, [])
  const elapsed = Math.max(0, (now - startedAt) / 1000)
  return (
    <div className="mt-1 flex items-center gap-1.5 text-body text-muted-foreground">
      <ChatRunningIcon size={14} className="shrink-0" />
      <span className="tabular-nums text-muted-foreground/70">{elapsed.toFixed(1)}s</span>
    </div>
  )
}
