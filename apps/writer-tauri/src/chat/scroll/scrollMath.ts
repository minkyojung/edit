// Pure geometry for the chat transcript's scroll behaviour.
//
// The ChatPanel effect is a thin adapter: it reads DOM rects, builds the
// plain structs below, calls these functions, and issues the scroll. Keeping
// the math here (no DOM, number-in/number-out) makes it unit-testable in
// jsdom without real scrolling or a live WKWebView.

/** Who owns the scroll position right now.
 * - FOLLOW_BOTTOM: stick to the bottom, chase new/streamed content.
 * - ANCHORED: a just-sent question is pinned near the top; the reply fills
 *   the space below it.
 * - FREE: the user scrolled away to read history — nobody auto-scrolls. */
export type ScrollMode = 'FOLLOW_BOTTOM' | 'ANCHORED' | 'FREE'

/** Distance-from-bottom (px) under which the user counts as "at the bottom"
 * and we (re-)enter bottom-follow. Matches the pre-refactor 80px threshold. */
export const PIN_THRESHOLD = 80

export interface AnchorGeom {
  /** container.scrollTop */
  scrollTop: number
  /** container.getBoundingClientRect().top */
  containerTop: number
  /** container.clientHeight */
  clientHeight: number
  /** container paddingTop (= --chat-top-inset), the glass band height */
  insetTop: number
  /** floating composer height, overlaid at the container's bottom */
  footerHeight: number
  /** anchored bubble's inner-content rect.top (viewport coords) */
  bubbleTop: number
  /** anchored bubble's inner-content rect.bottom (viewport coords) */
  bubbleBottom: number
}

/** In the tall-bubble case, the fraction of the usable viewport kept below the
 * question's tail for the reply to begin streaming into. */
export const TALL_REPLY_RESERVE = 0.4

/** scrollTop that positions the anchored bubble. We own the position directly
 * (rather than scrollIntoView + a CSS scroll-margin-top) because WKWebView
 * drops scroll-margin-top on smooth scrolls, dumping the bubble behind the
 * opaque header band.
 *
 * Height-aware: a bubble that fits gets its TOP pinned just below the inset
 * band; a bubble taller than the viewport gets its BOTTOM landed partway down,
 * so the question's tail and the reply's start are both visible instead of
 * pinning the top and pushing the reply off-screen below. */
export function computeAnchorScrollTop(g: AnchorGeom): number {
  // Usable height between the glass inset band (top) and the composer (bottom).
  const viewport = g.clientHeight - g.insetTop - g.footerHeight
  const bubbleHeight = g.bubbleBottom - g.bubbleTop

  if (bubbleHeight <= viewport) {
    // Position of the bubble's top in the container's scroll-content coordinate
    // system (invariant of the current scroll offset).
    const bubbleContentTop = g.scrollTop + (g.bubbleTop - g.containerTop)
    return Math.max(0, bubbleContentTop - g.insetTop)
  }

  // Taller than the viewport: land the bubble's bottom at (1 - reserve) of the
  // way down the usable area, leaving `TALL_REPLY_RESERVE` of it for the reply.
  const bubbleContentBottom = g.scrollTop + (g.bubbleBottom - g.containerTop)
  const desiredOffset = g.insetTop + viewport * (1 - TALL_REPLY_RESERVE)
  return Math.max(0, bubbleContentBottom - desiredOffset)
}

/** Gap (px) kept below the last content before we consider the viewport
 * "filled" and hand off from ANCHORED to bottom-follow. */
export const REPLY_GAP = 24

export interface FollowGeom {
  /** last turn's inner-content rect.bottom (viewport coords), measured AFTER
   * the anchor jump has settled — NOT the min-height-inflated wrapper */
  contentBottom: number
  /** container.getBoundingClientRect().top */
  containerTop: number
  /** container.clientHeight */
  clientHeight: number
  /** floating composer height, overlaid at the container's bottom */
  footerHeight: number
  /** gap kept below the content (= REPLY_GAP) */
  replyGap: number
}

/** Once anchored, decide whether the streamed reply has grown enough to fill
 * the viewport — at which point we hand off to bottom-follow so the streaming
 * tail stays visible (instead of scrolling off the bottom while the question
 * stays pinned). Compares the last content's bottom against the usable
 * viewport bottom (above the composer). Must be evaluated with a settled
 * scroll position, using the inner content — the min-height reservation
 * inflates the wrapper, so `scrollHeight` would read "overflowing" always. */
export function shouldFollowFromAnchor(g: FollowGeom): boolean {
  return g.contentBottom - g.containerTop >= g.clientHeight - g.footerHeight - g.replyGap
}

/** Absolute-bottom scrollTop for a container. */
export function bottomScrollTop(scrollHeight: number, clientHeight: number): number {
  return Math.max(0, scrollHeight - clientHeight)
}

/** Mode to enter after a genuine (non-programmatic) user scroll: snap back to
 * bottom-follow when they return to the bottom, otherwise free them. */
export function nextModeOnScroll(distanceFromBottom: number): ScrollMode {
  return distanceFromBottom < PIN_THRESHOLD ? 'FOLLOW_BOTTOM' : 'FREE'
}
