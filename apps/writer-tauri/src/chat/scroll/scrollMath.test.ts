import { describe, expect, it } from 'vitest'
import {
  PIN_THRESHOLD,
  TALL_REPLY_RESERVE,
  bottomScrollTop,
  computeAnchorScrollTop,
  nextModeOnScroll,
  shouldFollowFromAnchor,
} from './scrollMath'

// container: top=0, clientHeight=800, inset(top band)=100, footer(composer)=100
// → usable viewport = 800 - 100 - 100 = 600
const base = {
  scrollTop: 500,
  containerTop: 0,
  clientHeight: 800,
  insetTop: 100,
  footerHeight: 100,
}

describe('computeAnchorScrollTop', () => {
  it('pins a bubble that fits to just below the inset band', () => {
    // bubbleHeight 50 <= viewport 600 → fits branch.
    // bubbleContentTop = 500 + (300 - 0) = 800; target = 800 - inset(100) = 700.
    const top = computeAnchorScrollTop({ ...base, bubbleTop: 300, bubbleBottom: 350 })
    expect(top).toBe(700)
  })

  it('lands a bubble at exactly viewport height via the fits branch', () => {
    // bubbleHeight 600 === viewport 600 → still fits (<=).
    // bubbleContentTop = 500 + 200 = 700; target = 700 - 100 = 600.
    const top = computeAnchorScrollTop({ ...base, bubbleTop: 200, bubbleBottom: 800 })
    expect(top).toBe(600)
  })

  it('lands a taller-than-viewport bubble so its tail + reply reserve show', () => {
    // bubbleHeight 1000 > viewport 600 → tall branch.
    // bubbleContentBottom = 500 + 1200 = 1700.
    // desiredOffset = inset(100) + 600 * (1 - 0.4) = 460.
    // target = 1700 - 460 = 1240.
    const top = computeAnchorScrollTop({ ...base, bubbleTop: 200, bubbleBottom: 1200 })
    expect(top).toBe(1240)
    // After scrolling there, the bubble's bottom sits `reserve` above the
    // usable bottom, leaving room for the reply.
    const bubbleBottomInViewport = 500 + 1200 - top
    const usableBottom = base.clientHeight - base.footerHeight
    expect(usableBottom - bubbleBottomInViewport).toBeCloseTo(600 * TALL_REPLY_RESERVE)
  })

  it('never returns a negative scrollTop', () => {
    const top = computeAnchorScrollTop({
      ...base,
      scrollTop: 0,
      bubbleTop: 50,
      bubbleBottom: 90,
    })
    expect(top).toBeGreaterThanOrEqual(0)
  })
})

describe('bottomScrollTop', () => {
  it('is the overflow height', () => {
    expect(bottomScrollTop(2000, 800)).toBe(1200)
  })
  it('clamps to zero when content fits', () => {
    expect(bottomScrollTop(500, 800)).toBe(0)
  })
})

describe('nextModeOnScroll', () => {
  it('follows the bottom within the threshold', () => {
    expect(nextModeOnScroll(0)).toBe('FOLLOW_BOTTOM')
    expect(nextModeOnScroll(PIN_THRESHOLD - 1)).toBe('FOLLOW_BOTTOM')
  })
  it('frees the scroll at or beyond the threshold', () => {
    expect(nextModeOnScroll(PIN_THRESHOLD)).toBe('FREE')
    expect(nextModeOnScroll(400)).toBe('FREE')
  })
})

describe('shouldFollowFromAnchor', () => {
  // usable bottom = clientHeight(800) - footer(100) - gap(24) = 676
  const g = { containerTop: 0, clientHeight: 800, footerHeight: 100, replyGap: 24 }

  it('hands off once the reply fills the usable viewport', () => {
    expect(shouldFollowFromAnchor({ ...g, contentBottom: 676 })).toBe(true)
    expect(shouldFollowFromAnchor({ ...g, contentBottom: 700 })).toBe(true)
  })
  it('stays anchored while the reply is still short', () => {
    expect(shouldFollowFromAnchor({ ...g, contentBottom: 675 })).toBe(false)
    expect(shouldFollowFromAnchor({ ...g, contentBottom: 300 })).toBe(false)
  })
})
