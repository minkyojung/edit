// Context-window size (input tokens) per model.
//
// STEP 2 estimate only: used by the context gauge to compute a used/total
// fraction before the sidecar switches to streaming-input mode. Once that
// migration lands (STEP 3), query.getContextUsage() returns the authoritative
// `maxTokens` and this estimate is no longer the source of truth.
//
// All currently offered chat models (Haiku 4.5 / Sonnet 4.6 / Opus 4.8)
// expose a 200k window; the 1M-context beta is not enabled on the chat
// sidecar, so a single constant is correct today. The signature takes the
// model id so callers don't change when per-model limits diverge later.

const DEFAULT_CONTEXT_LIMIT = 200_000

export function contextLimitForModel(_model: string): number {
  return DEFAULT_CONTEXT_LIMIT
}
