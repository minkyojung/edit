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
