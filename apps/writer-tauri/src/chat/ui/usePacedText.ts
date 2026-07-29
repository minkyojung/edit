import { useEffect, useMemo, useRef, useState } from 'react'

// Smooth streaming: decouple display rate from arrival rate. The streaming
// pipeline updates `content` in ~120ms bursts (throttled flusher), which reads
// as choppy jumps. This hook treats `content` as the TARGET and reveals it on a
// requestAnimationFrame loop, advancing each frame by a step proportional to the
// remaining backlog — fast when far behind, gentle near the end, always catching
// up. Reveal is grapheme-based (Intl.Segmenter) so Hangul/emoji never split.

const DIVISOR = 8 // larger = gentler catch-up (fraction of backlog drained per frame)
const MIN_STEP = 1 // graphemes per frame floor, so it always finishes

// Commit pacing. Advancing the reveal is nearly free; COMMITTING it is not —
// each commit re-renders StreamingMarkdown, and react-markdown re-parses the
// whole answer every render (it memoizes nothing). That parse is linear in
// length: ~3ms at 2KB, ~11ms at 10KB, ~24ms at 20KB. Committing every frame
// therefore spends more than the entire frame budget on a long answer, and the
// backlog maths guarantees every frame does commit: each frame drains 1/8 of
// the backlog, so across a 120ms arrival window the backlog only falls to
// (7/8)^7.2 ≈ 0.38 of itself — it never reaches zero while tokens keep coming,
// so the loop never idles.
//
// So the reveal keeps advancing per frame (which is what makes the visible
// jumps evenly spaced) but the commit is rate-limited, and the limit widens
// with length because that's what the cost does. Same lever assistant-ui
// exposes as `minCommitMs` and LobeChat scales with tail length.
const COMMIT_MIN_MS = 32 // short answers: parse is cheap, stay smooth
const COMMIT_MAX_MS = 96 // long answers: parse dominates, back off
const COMMIT_RAMP_FROM = 2_000 // chars — below this, always the floor
const COMMIT_RAMP_TO = 16_000 // chars — above this, always the ceiling

// One shared segmenter; locale-agnostic grapheme clustering is what we want.
const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null

/** Cumulative string offsets at each grapheme boundary. `offs[n]` is the string
 * index just past the first `n` graphemes, so `s.slice(0, offs[n])` shows `n`
 * graphemes. Length is graphemeCount + 1 (offs[0] = 0, offs[count] = s.length). */
function graphemeOffsets(s: string): number[] {
  const offs = [0]
  if (segmenter) {
    let idx = 0
    for (const { segment } of segmenter.segment(s)) {
      idx += segment.length
      offs.push(idx)
    }
  } else {
    // Fallback: code-point offsets (still avoids splitting surrogate pairs).
    let idx = 0
    for (const ch of s) {
      idx += ch.length
      offs.push(idx)
    }
  }
  return offs
}

/** How long to wait between commits for an answer of `length` characters.
 * Widens linearly across the ramp, clamped at both ends. */
export function commitIntervalMs(length: number): number {
  const t = (length - COMMIT_RAMP_FROM) / (COMMIT_RAMP_TO - COMMIT_RAMP_FROM)
  const clamped = Math.min(1, Math.max(0, t))
  return Math.round(COMMIT_MIN_MS + clamped * (COMMIT_MAX_MS - COMMIT_MIN_MS))
}

export type PacerState = {
  /** Graphemes the pacer has revealed. Advances every frame. */
  revealed: number
  /** Graphemes actually handed to React. Lags `revealed` between commits. */
  committed: number
  /** When `committed` last moved, on the same clock as `now`. */
  lastCommitAt: number
}

/**
 * One animation frame of pacing. Pure so the commit-rate contract can be
 * checked against a synthetic clock — the expensive half of this hook is
 * invisible from here, so a test that drives the real hook would be measuring
 * the wrong thing.
 */
export function advancePacer(
  state: PacerState,
  { total, now, intervalMs }: { total: number; now: number; intervalMs: number },
): PacerState {
  const revealed = Math.min(
    total,
    state.revealed >= total
      ? total
      : state.revealed + Math.max(MIN_STEP, Math.ceil((total - state.revealed) / DIVISOR)),
  )
  // Commit on the interval, or the moment the answer is fully revealed —
  // otherwise the closing words sit invisible for up to an interval, which
  // reads as a truncated answer rather than a slow one.
  const due = revealed >= total || now - state.lastCommitAt >= intervalMs
  if (!due) return { ...state, revealed }
  return { revealed, committed: revealed, lastCommitAt: now }
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * Returns the portion of `content` to display, paced smoothly while streaming.
 * When `isStreaming` is false (settled / historical message) or the user prefers
 * reduced motion, returns the full content immediately.
 */
export function usePacedText(content: string, isStreaming: boolean): string {
  const offsets = useMemo(() => graphemeOffsets(content), [content])
  const total = offsets.length - 1
  const reduce = useMemo(prefersReducedMotion, [])

  // Initialise to full when there's nothing to animate (settled message, reduced
  // motion) so historical content never flashes empty for a frame.
  const [displayed, setDisplayed] = useState(() => (isStreaming && !reduce ? 0 : total))
  // The pacer's own position, which advances every frame whether or not that
  // frame commits. Kept in a ref because only `committed` may drive a render.
  const pacer = useRef<PacerState>({
    revealed: displayed,
    committed: displayed,
    lastCommitAt: 0,
  })
  const displayedRef = useRef(displayed)
  displayedRef.current = displayed
  pacer.current.committed = displayed

  useEffect(() => {
    // Snap to full: not streaming, reduced motion, or content shrank (e.g. a
    // settle hook replaced the text with a shorter summary).
    if (!isStreaming || reduce || pacer.current.revealed > total) {
      pacer.current.revealed = total
      if (pacer.current.committed !== total) setDisplayed(total)
      return
    }
    if (pacer.current.revealed >= total) return // already caught up

    const intervalMs = commitIntervalMs(content.length)
    let raf = 0
    const tick = (now: number) => {
      const next = advancePacer(pacer.current, { total, now, intervalMs })
      pacer.current = next
      if (next.committed !== displayedRef.current) {
        displayedRef.current = next.committed
        setDisplayed(next.committed)
      }
      if (next.revealed < total) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [total, isStreaming, reduce, content.length])

  const n = Math.min(displayed, total)
  return content.slice(0, offsets[n])
}
