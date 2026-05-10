/** Pull the leading `^([A-Z_]+):` classifier from an error so the renderer
 * can branch on it (e.g. show a Reconnect button only for AUTH). Returns
 * undefined for errors that don't carry one. */
export function extractErrorCode(e: unknown): string | undefined {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.match(/^([A-Z_]+):/)?.[1]
}

/** Coerce whatever the SDK / fetch / our own code threw into a single
 * readable line. Recognises a small set of well-known codes from the
 * sidecar (NETWORK / IDLE_TIMEOUT / SIDECAR_DIED / AUTH / RATE_LIMIT) and
 * maps them to user-friendly copy; falls through to message cleanup for
 * everything else. */
export function humanizeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const code = raw.match(/^([A-Z_]+):/)?.[1]
  switch (code) {
    case 'SIDECAR_DIED':
      return 'Backend service crashed and is restarting — please try again'
    case 'IDLE_TIMEOUT':
      return 'No response — check your network connection'
    case 'NETWORK':
      return 'Network error — check your connection'
    case 'AUTH':
      return 'Authentication failed — please sign in again'
    case 'RATE_LIMIT':
      return 'Rate limited — try again in a moment'
  }
  let msg = raw.replace(/^Error:\s*/i, '').trim()
  if (msg.length === 0) return 'Something went wrong'
  if (msg.length > 240) msg = msg.slice(0, 237) + '…'
  return msg
}

/** Outcome of a finished assistant run from the catch path's point of view —
 * what status the turn settles to, what error UI (if any) to render, and the
 * chat-level status the input row should reflect. Captures the three branches
 * (user-pressed stop / offline abort / real error) in one shape so the caller
 * doesn't have to re-derive them from the raw error every time. */
export type RunOutcome = {
  /** Status to commit on the assistant turn — drives StoppedCard vs ErrorCard. */
  terminal: 'error' | 'stopped'
  /** Status the PromptInput uses to decide whether to re-enable Send. */
  chatStatus: 'error' | 'idle'
  /** Human-facing error message; `null` for the muted "Stopped" path. */
  errorText: string | null
  /** Coarse classifier from the error's `^([A-Z_]+):` prefix; consumed by
   * ErrorCard to branch on AUTH (Reconnect button) and RATE_LIMIT (countdown). */
  errorCode: string | undefined
  /** ms-epoch when the rate-limit window resets — only set for RATE_LIMIT. */
  resetsAt: number | undefined
}

/** Classify an error thrown by `runChat`. Mirrors three branches:
 * - User pressed Stop → AbortError without offlineAborted → "stopped" card.
 * - OS reported offline mid-stream → AbortError + offlineAborted → "error"
 *   card with NETWORK code so the user sees a Retry, not a muted Stop.
 * - Anything else → "error" card with a humanized message + classifier code. */
export function classifyRunError(
  error: unknown,
  opts: { offlineAborted: boolean },
): RunOutcome {
  const aborted = error instanceof DOMException && error.name === 'AbortError'
  const isError = !aborted || opts.offlineAborted
  const errorText = !aborted
    ? humanizeError(error)
    : opts.offlineAborted
      ? 'Lost network connection'
      : null
  const errorCode = !aborted
    ? extractErrorCode(error)
    : opts.offlineAborted
      ? 'NETWORK'
      : undefined
  // RATE_LIMIT errors carry a `rateLimit.resetsAt` (ms epoch) attached by
  // `runChat` from the SDK's most recent rate_limit_event. The error card
  // uses it to drive a countdown and gate Retry.
  const rateLimit = (error as Error & { rateLimit?: { resetsAt?: number } })?.rateLimit
  const resetsAt = errorCode === 'RATE_LIMIT' ? rateLimit?.resetsAt : undefined
  return {
    terminal: isError ? 'error' : 'stopped',
    chatStatus: isError ? 'error' : 'idle',
    errorText,
    errorCode,
    resetsAt,
  }
}

/** Map an Anthropic stop_reason to a user-facing message. Returns null for
 * routine reasons (`end_turn`, `stop_sequence`, `tool_use`, missing) so the
 * footer stays clean — only abnormal stops surface here. */
export function describeStopReason(reason: string | null | undefined): string | null {
  switch (reason) {
    case 'max_tokens':
      return 'Response cut off (token limit)'
    case 'pause_turn':
      return 'Paused'
    case 'refusal':
      return 'Refused'
    default:
      return null
  }
}
