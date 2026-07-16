// Inline suggestion swap, faithful to the real CodeMirror proof-review
// (editor/cmInBufferReview.ts): the old text stays IN PLACE, struck through
// (cm-proof-old), and a widget right after it holds the green replacement plus
// ✓ / ✕ — all inline, mid-sentence:
//
//   Solitude [is just being by yourself.](red strike)[has a texture…](green) ✓ ✕
//
// Real accept dispatches a text replace (old range → new) and is instant. Here
// we add a demo animation: on accept the struck text collapses its own width
// (the following text reflows into the gap continuously — a real layout prop,
// not `layout` snapshotting) while ✓/✕ fade, then the green highlight melts to
// plain committed prose.

import { AnimatePresence, motion } from 'motion/react'
import type { CSSProperties } from 'react'

export type SwapState = 'proposed' | 'accepted' | 'done'

// Struck old text — inline-block + overflow so its width can animate to 0.
const OLD_STYLE: CSSProperties = {
  textDecoration: 'line-through',
  color: 'var(--muted-foreground)',
  background: 'color-mix(in oklch, var(--destructive, crimson) 14%, transparent)',
  borderRadius: '3px',
  display: 'inline-block',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  verticalAlign: 'bottom',
}

// rgba (not color-mix) so Motion can interpolate the highlight to transparent on
// commit. Matches the proof-review green (#2ecc71).
const GREEN = '46, 204, 113'

const COLLAPSE = { type: 'spring', stiffness: 260, damping: 30 } as const

export function SuggestionSwap({
  state,
  prefix,
  before,
  after,
}: {
  state: SwapState
  /** Shared, unchanged text — stays plain (never marked). */
  prefix: string
  before: string
  after: string
}) {
  const proposed = state === 'proposed'
  return (
    <span>
      {prefix}
      {/* Old text — collapses its width to 0 on accept; the green text after it
          reflows left into the gap. */}
      <AnimatePresence initial={false}>
        {proposed && (
          <motion.span
            key="old"
            style={OLD_STYLE}
            exit={{ width: 0, opacity: 0 }}
            transition={COLLAPSE}
          >
            {before}
          </motion.span>
        )}
      </AnimatePresence>

      {/* New text — highlighted green while pending, melts to plain on commit. */}
      <motion.span
        style={{ borderRadius: '3px', padding: '0 0.2em', marginLeft: '0.1em' }}
        initial={false}
        animate={{ backgroundColor: state === 'done' ? `rgba(${GREEN}, 0)` : `rgba(${GREEN}, 0.22)` }}
        transition={{ duration: 0.45, ease: 'easeOut' }}
      >
        {after}
      </motion.span>

      {/* ✓ / ✕ — inline right after the replacement, exactly like the widget. */}
      <AnimatePresence initial={false}>
        {proposed && (
          <motion.span
            key="actions"
            className="ml-1 inline-flex gap-0.5 align-middle"
            exit={{ opacity: 0, width: 0 }}
            transition={{ duration: 0.2 }}
          >
            <span className="rounded border border-border bg-background px-1 text-caption leading-tight text-emerald-500">
              ✓
            </span>
            <span className="rounded border border-border bg-background px-1 text-caption leading-tight text-destructive">
              ✕
            </span>
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  )
}
