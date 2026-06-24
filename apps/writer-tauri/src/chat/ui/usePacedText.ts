import { useEffect, useMemo, useRef, useState } from 'react'

// Smooth streaming: decouple display rate from arrival rate. The streaming
// pipeline updates `content` in ~120ms bursts (throttled flusher), which reads
// as choppy jumps. This hook treats `content` as the TARGET and reveals it on a
// requestAnimationFrame loop, advancing each frame by a step proportional to the
// remaining backlog — fast when far behind, gentle near the end, always catching
// up. Reveal is grapheme-based (Intl.Segmenter) so Hangul/emoji never split.

const DIVISOR = 8 // larger = gentler catch-up (fraction of backlog drained per frame)
const MIN_STEP = 1 // graphemes per frame floor, so it always finishes

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
  const displayedRef = useRef(displayed)
  displayedRef.current = displayed

  useEffect(() => {
    // Snap to full: not streaming, reduced motion, or content shrank (e.g. a
    // settle hook replaced the text with a shorter summary).
    if (!isStreaming || reduce || displayedRef.current > total) {
      if (displayedRef.current !== total) setDisplayed(total)
      return
    }
    if (displayedRef.current >= total) return // already caught up

    let raf = 0
    const tick = () => {
      const cur = displayedRef.current
      const remaining = total - cur
      if (remaining <= 0) return
      const step = Math.max(MIN_STEP, Math.ceil(remaining / DIVISOR))
      setDisplayed(Math.min(total, cur + step))
      if (cur + step < total) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [total, isStreaming, reduce])

  const n = Math.min(displayed, total)
  return content.slice(0, offsets[n])
}
