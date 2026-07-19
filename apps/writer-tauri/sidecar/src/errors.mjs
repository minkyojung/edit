// Error taxonomy — pure functions mapping SDK / thrown errors to the host's
// error contract. No SDK or server state; extracted from server.mjs so the
// classification lives in one testable place. The host owns the final
// user-facing copy (humanizeError); these only pick the code + retryability.

// Codes the user can't fix by retrying the same request. Used to set the
// `retryable` flag (host hides the Retry button for these).
export const NON_RETRYABLE_CODES = new Set(['AUTH', 'INVALID', 'BILLING', 'BUDGET'])

// Shape the SDK's `rate_limit_info` into the compact reset payload the host
// attaches to a RATE_LIMIT error (resetsAt drives the countdown / date;
// rateLimitType + overageDisabledReason pick the distinct copy). Returns
// undefined when there's nothing to carry so the field is simply absent.
export function rateLimitPayload(info) {
  if (!info) return undefined
  // When the block is on the overage (paid) budget, the reset lives in
  // `overageResetsAt`, not `resetsAt` (sdk.d.ts SDKRateLimitInfo) — fall back to
  // it so an overage rejection still shows a countdown instead of a blank one.
  const resetsAt =
    typeof info.resetsAt === 'number'
      ? info.resetsAt
      : typeof info.overageResetsAt === 'number'
        ? info.overageResetsAt
        : undefined
  return {
    resetsAt,
    rateLimitType: info.rateLimitType,
    overageDisabledReason: info.overageDisabledReason,
  }
}

// Map a structured SDK error — the result `subtype` and/or the mid-turn
// SDKAssistantMessageError — to a host error code, an English fallback
// message, and retryability. The host owns the final user-facing copy
// (humanizeError) for every code except EXEC, which forwards the SDK's own
// `errors[0]` detail. `assistantError` is more specific than a generic
// `error_during_execution` subtype, so it wins when both are present.
export function mapSdkError({ subtype, assistantError, errors }) {
  switch (assistantError) {
    case 'authentication_failed':
      return { code: 'AUTH', message: 'authentication failed', retryable: false }
    case 'rate_limit':
      return { code: 'RATE_LIMIT', message: 'rate limited', retryable: true }
    case 'billing_error':
      return { code: 'BILLING', message: 'credit balance too low', retryable: false }
    case 'server_error':
      return { code: 'SERVER', message: 'service is busy', retryable: true }
    case 'invalid_request':
      return { code: 'INVALID', message: 'invalid request', retryable: false }
    case 'max_output_tokens':
      return { code: 'TRUNCATED', message: 'response was cut off', retryable: true }
    default:
      break
  }
  switch (subtype) {
    case 'error_max_turns':
      return { code: 'MAX_TURNS', message: 'stopped after too many tool steps', retryable: true }
    case 'error_max_budget_usd':
      return { code: 'BUDGET', message: 'hit the cost limit', retryable: false }
    case 'error_max_structured_output_retries':
      return { code: 'FORMAT', message: 'could not produce a valid result format', retryable: true }
    case 'error_during_execution':
    default: {
      // Forward the SDK's own `errors[0]` detail (may be empty); the host
      // composes the final "Stopped on an error[: detail]" copy.
      const detail = Array.isArray(errors) && errors.length > 0 ? String(errors[0]) : ''
      return { code: 'EXEC', message: detail, retryable: true }
    }
  }
}

export function classifyError(err) {
  // Prefer a structured HTTP status when the thrown error carries one
  // (Anthropic SDK errors expose `.status`); fall back to message regex.
  const status = typeof err?.status === 'number' ? err.status : undefined
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return 'INVALID'
  if (status === 500 || status === 529) return 'SERVER'
  const msg = err?.message ? String(err.message) : String(err)
  if (/401|unauthor|invalid[_ ]?token/i.test(msg)) return 'AUTH'
  if (/429|rate[_ ]?limit/i.test(msg)) return 'RATE_LIMIT'
  if (/ETIMEDOUT|timed[_ ]?out/i.test(msg)) return 'IDLE_TIMEOUT'
  if (/network|fetch failed|ECONN/i.test(msg)) return 'NETWORK'
  return 'INTERNAL'
}
