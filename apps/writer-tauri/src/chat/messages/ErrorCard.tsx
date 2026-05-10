import type React from 'react'
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react'
import type { ChatTurn } from '@/chat/types'
import { InlineCard, InlineCardFooter } from '@/chat/ui/InlineCard'
import { ReconnectButton } from '@/chat/messages/ReconnectButton'
import { useCountdown } from '@/chat/utils/useCountdown'
import { formatCountdown } from '@/chat/utils/formatCountdown'

/** Destructive error card for a failed assistant turn. Branches on
 * `turn.errorCode` to surface a `Reconnect` button (AUTH) or a precise
 * countdown that gates `Retry` (RATE_LIMIT). Anything that streamed
 * before the failure stays in the body so the user can see how far the
 * model got. */
export function ErrorCard({
  turn,
  body,
  hasText,
  hasThinking,
  durationLabel,
  onRegenerate,
}: {
  turn: ChatTurn
  body: React.ReactNode
  hasText: boolean
  hasThinking: boolean
  durationLabel: string | null
  onRegenerate?: (turnId: string) => void
}) {
  const isAuthError = turn.errorCode === 'AUTH'
  const isRateLimited = turn.errorCode === 'RATE_LIMIT'
  // Only feed the countdown a target when this card is RATE_LIMIT and we
  // actually have a reset timestamp — otherwise the hook's interval would
  // run for non-rate-limit cards too.
  const remaining = useCountdown(isRateLimited ? turn.resetsAt : undefined)
  const retryDisabled = remaining > 0
  // While the countdown ticks, swap the static error message for a live
  // "retry in 28s" label. Once it hits zero we fall back to the original
  // (the SDK's own message) so the user can still copy/inspect it.
  const message =
    isRateLimited && remaining > 0
      ? `Rate limited — retry in ${formatCountdown(remaining)}`
      : turn.errorText ?? "Couldn't complete response"
  const hasBody = (turn.parts && turn.parts.length > 0) || hasText || hasThinking
  return (
    <InlineCard tone="destructive">
      {hasBody && <div className="px-3 py-2">{body}</div>}
      <InlineCardFooter tone="destructive">
        <IconAlertTriangle size={12} className="shrink-0 opacity-80" />
        <span className="flex-1 min-w-0 truncate" title={turn.errorText ?? undefined}>
          {message}
        </span>
        {durationLabel && <span className="opacity-70 shrink-0">{durationLabel}</span>}
        {isAuthError && <ReconnectButton />}
        {onRegenerate && (
          <button
            type="button"
            onClick={() => onRegenerate(turn.id)}
            disabled={retryDisabled}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-destructive transition-colors shrink-0 outline-none hover:bg-destructive/15 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed"
            title={retryDisabled ? `Retry available in ${formatCountdown(remaining)}` : 'Retry'}
          >
            <IconRefresh size={11} />
            <span className="font-medium">Retry</span>
          </button>
        )}
      </InlineCardFooter>
    </InlineCard>
  )
}
