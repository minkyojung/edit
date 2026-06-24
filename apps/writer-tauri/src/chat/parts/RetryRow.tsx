import { IconRefresh } from '@tabler/icons-react'
import type { RetryPart } from '@/chat/types'
import { ActivityRow } from '@/chat/parts/ActivityRow'

/** An `api_retry` indicator — the SDK is retrying a transient API error after a
 * back-off. Rendered through ActivityRow so it shares the activity stream's
 * look; passive (no detail → no chevron) like the compact divider. Tells the
 * user the otherwise-silent pause is a recovery, not a hang. */
export function RetryRow({ part }: { part: RetryPart }) {
  const reason = part.error ? RETRY_REASONS[part.error] ?? part.error.replace(/_/g, ' ') : ''
  const count = part.attempt && part.maxRetries ? ` (${part.attempt}/${part.maxRetries})` : ''
  return (
    <ActivityRow
      icon={<IconRefresh size={14} />}
      label={`Retrying${reason ? ` after ${reason}` : ''}${count}…`}
    />
  )
}

/** SDKAssistantMessageError label → short human phrase for the retry row.
 * (The SDK's error union is authentication_failed | billing_error | rate_limit
 * | invalid_request | server_error | unknown | max_output_tokens — only the
 * transient ones reach here; anything unmapped falls back to the raw label.) */
const RETRY_REASONS: Record<string, string> = {
  server_error: 'a server error',
  rate_limit: 'a rate limit',
}
