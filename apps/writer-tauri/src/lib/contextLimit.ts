// Context-window size (input tokens) per model.
//
// STEP 2 estimate only: used by the context gauge to compute a used/total
// fraction before the sidecar switches to streaming-input mode. Once that
// migration lands (STEP 3), query.getContextUsage() returns the authoritative
// `maxTokens` and this estimate is no longer the source of truth.
//
// Sonnet 5 / Sonnet 4.6 / Opus 5 / Opus 4.8 / Fable 5 expose a native 1M-token
// window at standard pricing (no beta flag, no long-context premium); Haiku 4.5
// tops out at 200k.
// Unknown ids fall back to the conservative 200k so the gauge never
// under-reports how full the window is.

import { modelFactsFor } from '@/chat/modelFacts'

const DEFAULT_CONTEXT_LIMIT = 200_000
const MILLION = 1_000_000

/** Input-token window per model id. Keyed by the bare ids we send to the
 * sidecar; anything else uses DEFAULT_CONTEXT_LIMIT. */
const CONTEXT_LIMITS: Record<string, number> = {
  'claude-haiku-4-5': 200_000,
  'claude-sonnet-5': MILLION,
  'claude-sonnet-4-6': MILLION,
  'claude-opus-5': MILLION,
  'claude-opus-4-8': MILLION,
  'claude-fable-5': MILLION,
}

/** Window size for a model id.
 *
 * The fetched catalog wins here — unlike labels and effort tiers, this is a
 * plain fact with no product judgement in it, and the hand-maintained table is
 * exactly the thing that goes stale. It's also the one lookup whose fallback is
 * actively WRONG rather than merely plain: an id absent from the table silently
 * reports 200k, so every 1M-window model we hadn't added yet made the context
 * gauge read ~5x too full. */
export function contextLimitForModel(model: string): number {
  return modelFactsFor(model)?.maxInputTokens ?? CONTEXT_LIMITS[model] ?? DEFAULT_CONTEXT_LIMIT
}
