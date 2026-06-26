import type React from 'react'
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react'
import type { ChatTurn } from '@/chat/types'
import { InlineCard } from '@/chat/ui/InlineCard'
import { ReconnectButton } from '@/chat/messages/ReconnectButton'
import { useCountdown } from '@/chat/utils/useCountdown'
import { formatCountdown } from '@/chat/utils/formatCountdown'

/** A far-out reset (weekly cap) shown as an absolute local date/time —
 * "Jun 30, 2:00 PM" — instead of a seconds countdown that would read as days. */
function formatResetDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

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
  // Which quota window was hit, as a short label. Absent for non-subscription
  // rate limits.
  const windowLabel = isRateLimited ? RATE_LIMIT_WINDOWS[turn.rateLimitType ?? ''] : undefined
  // Distinguish the three rate-limit shapes — each gets different copy:
  //  • out of credits  → won't clear on its own; no countdown.
  //  • weekly / far reset → resets days out, so show a DATE not a seconds tick.
  //  • short (5-hour)  → a live "retry in mm:ss" countdown.
  const isOutOfCredits = isRateLimited && turn.overageDisabledReason === 'out_of_credits'
  const farReset =
    turn.resetsAt != null && turn.resetsAt - Date.now() > 6 * 60 * 60 * 1000
  const isLongWindow =
    isRateLimited &&
    !isOutOfCredits &&
    (/^seven_day/.test(turn.rateLimitType ?? '') || farReset)
  // Only run the live countdown for a short window with a reset time —
  // otherwise the hook's interval would tick for cards that don't need it.
  const useLiveCountdown = isRateLimited && !isOutOfCredits && !isLongWindow
  const remaining = useCountdown(useLiveCountdown ? turn.resetsAt : undefined)
  const retryDisabled =
    isOutOfCredits ||
    (isLongWindow && turn.resetsAt != null && turn.resetsAt > Date.now()) ||
    remaining > 0
  // Distinct copy per shape; fall back to the SDK's own message once a short
  // countdown elapses (so the user can still copy/inspect it).
  const weeklyLabel = windowLabel
    ? windowLabel[0].toUpperCase() + windowLabel.slice(1)
    : 'Weekly limit'
  const message = isOutOfCredits
    ? 'Out of credits — add credits to continue'
    : isLongWindow
      ? `${weeklyLabel} reached${turn.resetsAt ? ` — resets ${formatResetDate(turn.resetsAt)}` : ''}`
      : useLiveCountdown && remaining > 0
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
        <span className="flex-1 min-w-0 text-body font-medium leading-snug">{message}</span>
        {durationLabel && (
          <span className="mt-0.5 shrink-0 text-callout opacity-70">{durationLabel}</span>
        )}
        {isAuthError && <ReconnectButton />}
        {onRegenerate && turn.retryable !== false && (
          <button
            type="button"
            onClick={() => onRegenerate(turn.id)}
            disabled={retryDisabled}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-body font-medium text-destructive transition-colors outline-none hover:bg-destructive/15 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
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
        <div className="border-t border-destructive/20 px-3 py-1.5 text-body text-muted-foreground opacity-80 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          {body}
        </div>
      )}
    </InlineCard>
  )
}
