// The pacer's commit rate is a performance contract, not a detail.
//
// Every commit re-renders StreamingMarkdown, and react-markdown re-parses the
// WHOLE answer on every render (no memoization — verified in
// react-markdown@10.1.0 lib/index.js). That parse is linear in answer length:
// measured 3.1ms at 2KB, 11.2ms at 10KB, 24.3ms at 20KB. So commits-per-second
// multiplies directly into main-thread cost, and a pacer that commits every
// animation frame spends more than a full frame budget per frame on a long
// answer.
//
// These tests pin the policy — advance smoothly, commit sparsely — against a
// synthetic clock, the same way the Rust host tests restart_decision without
// spawning processes.

import { act } from 'react'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { advancePacer, commitIntervalMs, usePacedText, type PacerState } from './usePacedText'

const FRAME_MS = 1000 / 60

const start = (): PacerState => ({ revealed: 0, committed: 0, lastCommitAt: 0 })

/** Runs `frames` animation frames through the real pacer and reports how many
 * of them actually committed (i.e. would have re-rendered and re-parsed). */
function run(frames: number, total: number, intervalMs: number) {
  let state = start()
  let commits = 0
  for (let frame = 1; frame <= frames; frame++) {
    const next = advancePacer(state, { total, now: frame * FRAME_MS, intervalMs })
    if (next.committed !== state.committed) commits++
    state = next
  }
  return { commits, state }
}

describe('commit pacing', () => {
  it('advances every frame but commits a fraction of them', () => {
    // A long answer still arriving: one second of frames.
    const { commits, state } = run(60, 100_000, commitIntervalMs(20_000))

    // The reveal must keep moving every frame — that's what makes the commits
    // land evenly spaced instead of in bursts.
    expect(state.revealed).toBeGreaterThan(0)

    // But the expensive half must not. 60 commits/sec at 24ms per parse is
    // 1.5x the entire main thread.
    expect(commits).toBeLessThanOrEqual(15)
    expect(commits).toBeGreaterThan(0)
  })

  it('commits more often for a short answer than a long one', () => {
    // Parse cost scales with length, so the budget has to as well.
    const short = run(60, 100_000, commitIntervalMs(500)).commits
    const long = run(60, 100_000, commitIntervalMs(50_000)).commits
    expect(short).toBeGreaterThan(long)
  })

  it('widens the interval with answer length, within bounds', () => {
    expect(commitIntervalMs(500)).toBeLessThan(commitIntervalMs(50_000))
    // Bounded at both ends: never so tight it defeats the purpose, never so
    // slack the text visibly stutters.
    expect(commitIntervalMs(0)).toBeGreaterThanOrEqual(16)
    expect(commitIntervalMs(10_000_000)).toBeLessThanOrEqual(200)
  })
})

describe('reveal correctness', () => {
  it('reveals everything once the answer stops growing', () => {
    let state = start()
    for (let frame = 1; frame <= 600; frame++) {
      state = advancePacer(state, { total: 500, now: frame * FRAME_MS, intervalMs: 96 })
    }
    // No text may be stranded by the commit gate.
    expect(state.revealed).toBe(500)
    expect(state.committed).toBe(500)
  })

  it('commits the last graphemes immediately rather than waiting out the interval', () => {
    // Reaching the end mid-interval must not leave the final words invisible
    // for up to an interval — that reads as a truncated answer.
    let state: PacerState = { revealed: 9, committed: 0, lastCommitAt: 0 }
    state = advancePacer(state, { total: 10, now: 1, intervalMs: 96 })
    expect(state.revealed).toBe(10)
    expect(state.committed).toBe(10)
  })

  it('never reveals past the end when the target shrinks', () => {
    // A settle hook can replace the streamed text with a shorter summary.
    let state: PacerState = { revealed: 800, committed: 800, lastCommitAt: 0 }
    state = advancePacer(state, { total: 100, now: 500, intervalMs: 96 })
    expect(state.revealed).toBeLessThanOrEqual(100)
    expect(state.committed).toBeLessThanOrEqual(100)
  })
})

// The policy above is only worth anything if the hook actually routes through
// it. This drives the real hook with a controlled clock and counts renders,
// because a render is what costs — see the header note.
describe('usePacedText wiring', () => {
  let frame: (t: number) => void = () => {}

  beforeEach(() => {
    // One pending frame at a time, matching the hook's self-rescheduling loop.
    let pending: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      pending = cb
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {
      pending = null
    })
    frame = (t: number) => {
      const cb = pending
      pending = null
      cb?.(t)
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders far fewer times than there are frames', () => {
    const answer = 'x'.repeat(20_000)
    let renders = 0
    let shown = ''

    function Probe() {
      renders++
      shown = usePacedText(answer, true)
      return null
    }

    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(createElement(Probe)))

    const initialRenders = renders
    // One second of animation frames.
    for (let i = 1; i <= 60; i++) act(() => frame((i * 1000) / 60))
    const committed = renders - initialRenders

    // At 20KB an answer costs ~24ms to parse, so a render per frame is more
    // than the whole main thread. The ~96ms interval should land around ten.
    expect(committed).toBeLessThanOrEqual(15)
    expect(committed).toBeGreaterThan(0)
    // And it must actually be revealing text, not just idling.
    expect(shown.length).toBeGreaterThan(0)

    act(() => root.unmount())
  })

  it('still reveals the whole answer', () => {
    const answer = 'hello world'
    let shown = ''

    function Probe() {
      shown = usePacedText(answer, true)
      return null
    }

    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(createElement(Probe)))
    for (let i = 1; i <= 120; i++) act(() => frame((i * 1000) / 60))

    expect(shown).toBe(answer)
    act(() => root.unmount())
  })
})
