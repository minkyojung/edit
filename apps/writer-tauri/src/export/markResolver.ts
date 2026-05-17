/**
 * Mark resolver — given a (possibly edited) text and a sidecar entry, decide
 * where the mark should re-attach.
 *
 * Three-stage fallback (matches the plan):
 *   1. Quote appears exactly once  → CONFIDENT
 *   2. Quote appears N>1 times     → context-match + occurrence → CONFIDENT
 *   3. Quote not found             → fuzzy match (best window)  → DEGRADED
 *   4. Fuzzy below threshold       → ORPHANED (range = null)
 *
 * Fuzzy uses normalized Levenshtein ratio over a sliding window of size
 * `quote.length` (with a small ± slack). Threshold defaults are exposed so
 * Stage 2 can sweep multiple cutoffs and report results side-by-side.
 */

import type { AnchorSpec, ResolutionStatus } from './types.js'

export interface ResolverOptions {
  /** Levenshtein ratio above which we accept a fuzzy match. */
  fuzzyThreshold?: number
  /** How many chars of slack the fuzzy window slides ± quote.length. */
  fuzzySlack?: number
}

const DEFAULT_THRESHOLD = 0.75
const DEFAULT_SLACK = 8

export interface ResolveResult {
  status: ResolutionStatus
  range: { from: number; to: number } | null
  /** Score for the chosen match (1.0 = exact, ratio in [0, 1] otherwise). */
  score: number
}

export function resolveAnchor(
  text: string,
  anchor: AnchorSpec,
  options: ResolverOptions = {},
): ResolveResult {
  const threshold = options.fuzzyThreshold ?? DEFAULT_THRESHOLD
  const slack = options.fuzzySlack ?? DEFAULT_SLACK

  if (!anchor.quote) {
    return { status: 'orphaned', range: null, score: 0 }
  }

  const exactHits = findAllIndices(text, anchor.quote)

  // Stage 1: unique exact match → CONFIDENT
  if (exactHits.length === 1) {
    const from = exactHits[0]!
    return {
      status: 'confident',
      range: { from, to: from + anchor.quote.length },
      score: 1,
    }
  }

  // Stage 2: multiple exact matches → context disambiguation
  if (exactHits.length > 1) {
    const chosen = chooseByContext(text, exactHits, anchor)
    if (chosen !== null) {
      return {
        status: 'confident',
        range: { from: chosen, to: chosen + anchor.quote.length },
        score: 1,
      }
    }
    // Context didn't pin it down — fall through to fuzzy as a soft tiebreak.
  }

  // Stage 3: no exact match → fuzzy sweep
  const fuzzy = bestFuzzyMatch(text, anchor.quote, slack)
  if (fuzzy && fuzzy.score >= threshold) {
    return {
      status: 'degraded',
      range: { from: fuzzy.from, to: fuzzy.to },
      score: fuzzy.score,
    }
  }

  return { status: 'orphaned', range: null, score: fuzzy?.score ?? 0 }
}

function findAllIndices(text: string, needle: string): number[] {
  const out: number[] = []
  let from = 0
  while (from <= text.length) {
    const idx = text.indexOf(needle, from)
    if (idx === -1) break
    out.push(idx)
    from = idx + 1
  }
  return out
}

/**
 * Among candidate start positions, prefer the one whose surrounding text
 * best matches the recorded contextBefore/contextAfter. We score each
 * candidate as (commonSuffixLen(before) + commonPrefixLen(after)).
 *
 * Falls back to anchor.occurrence ordinal when context scores tie or are
 * all zero — covers the "duplicate paragraphs, no nearby distinguishing
 * text" case.
 */
function chooseByContext(
  text: string,
  candidates: number[],
  anchor: AnchorSpec,
): number | null {
  let bestIdx: number | null = null
  let bestScore = -1
  let tied = false
  candidates.forEach((from) => {
    const beforeWindow = text.slice(Math.max(0, from - anchor.contextBefore.length), from)
    const afterWindow = text.slice(
      from + anchor.quote.length,
      from + anchor.quote.length + anchor.contextAfter.length,
    )
    const score =
      commonSuffixLength(beforeWindow, anchor.contextBefore) +
      commonPrefixLength(afterWindow, anchor.contextAfter)
    if (score > bestScore) {
      bestScore = score
      bestIdx = from
      tied = false
    } else if (score === bestScore) {
      tied = true
    }
  })

  if (bestIdx !== null && !tied && bestScore > 0) return bestIdx

  // Tie or zero context score — fall back to recorded occurrence ordinal.
  if (anchor.occurrence >= 0 && anchor.occurrence < candidates.length) {
    return candidates[anchor.occurrence]!
  }
  return null
}

function commonSuffixLength(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1
  return i
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1
  return i
}

/**
 * Slide a window of size ~quote.length across text and find the best
 * Levenshtein match. Returns null if text is shorter than the window range.
 */
function bestFuzzyMatch(
  text: string,
  quote: string,
  slack: number,
): { from: number; to: number; score: number } | null {
  if (!quote) return null
  const minLen = Math.max(1, quote.length - slack)
  const maxLen = Math.min(text.length, quote.length + slack)
  let best: { from: number; to: number; score: number } | null = null

  for (let len = minLen; len <= maxLen; len += 1) {
    for (let from = 0; from + len <= text.length; from += 1) {
      const candidate = text.slice(from, from + len)
      const score = similarity(candidate, quote)
      if (!best || score > best.score) {
        best = { from, to: from + len, score }
      }
    }
  }
  return best
}

function similarity(a: string, b: string): number {
  if (a === b) return 1
  const dist = levenshtein(a, b)
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  return 1 - dist / maxLen
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length

  let prev = new Array<number>(b.length + 1)
  let curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j += 1) prev[j] = j

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length]!
}
