import type React from 'react'
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react'
import type { ChatTurn } from '@/chat/types'
import { InlineCard } from '@/chat/ui/InlineCard'
import { ReconnectButton } from '@/chat/messages/ReconnectButton'
import { useCountdown } from '@/chat/utils/useCountdown'
import { formatCountdown } from '@/chat/utils/formatCountdown'

/** SDK `rate_limit_event.rateLimitType` → short human label for the card. */
const RATE_LIMIT_WINDOWS: Record<string, string> = {
  five_hour: '5-hour limit',
  seven_day: 'weekly limit',
  seven_day_opus: 'weekly Opus limit',
  seven_day_sonnet: 'weekly Sonnet limit',
  overage: 'overage limit',
}

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
  // Which quota window was hit, as a short label — appended to the
  // rate-limit message so the user knows whether it's the 5-hour or a
  // weekly cap. Absent for non-subscription rate limits.
  const windowLabel = isRateLimited ? RATE_LIMIT_WINDOWS[turn.rateLimitType ?? ''] : undefined
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
      ? `Rate limited${windowLabel ? ` (${windowLabel})` : ''} — retry in ${formatCountdown(remaining)}`
      : turn.errorText ?? "Couldn't complete response"
  const hasBody = (turn.parts && turn.parts.length > 0) || hasText || hasThinking
  return (
    <InlineCard tone="destructive">
      {/* Error headline — the primary element. The reason leads (wraps, not
          truncates, so the whole message is legible) with the action and
          duration to its right. */}
      <div className="flex items-start gap-2 px-3 py-2.5 text-destructive">
        <IconAlertTriangle size={16} className="mt-px shrink-0 opacity-90" />
        <span className="flex-1 min-w-0 text-[14px] font-medium leading-snug">{message}</span>
        {durationLabel && (
          <span className="mt-0.5 shrink-0 text-[13px] opacity-70">{durationLabel}</span>
        )}
        {isAuthError && <ReconnectButton />}
        {onRegenerate && turn.retryable !== false && (
          <button
            type="button"
            onClick={() => onRegenerate(turn.id)}
            disabled={retryDisabled}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[14px] font-medium text-destructive transition-colors outline-none hover:bg-destructive/15 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            title={retryDisabled ? `Retry available in ${formatCountdown(remaining)}` : 'Retry'}
          >
            <IconRefresh size={14} />
            <span>Retry</span>
          </button>
        )}
      </div>
      {/* What the model streamed before it failed — secondary, muted, and
          divided off so it never competes with the error reason. */}
      {hasBody && (
        // Tight vertical rhythm: the body here is often a collapsed
        // ProcessGroup carrying its own `my-2`. Collapse the outer child's
        // top/bottom margin (established pattern) so the strip's vertical
        // padding (py-1.5) stays smaller than its horizontal (px-3).
        <div className="border-t border-destructive/20 px-3 py-1.5 text-[14px] text-muted-foreground opacity-80 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          {body}
        </div>
      )}
    </InlineCard>
  )
}
