// Floating readout off the editor's bottom edge, live as you type.
//
// Full mode: a small word/char count tag, bottom-right (glance-only).
// Compact mode: a Liquid-Glass capsule anchored bottom-RIGHT that can be
// FOLDED into a small glass circle (tucked in the corner) when it's in the
// way, and unfolded back. Expanded: a single count (words OR characters, click
// to toggle) + an Ask AI button + a collapse chevron. Container is
// pointer-events-none; each control opts back in.
import { useState } from 'react'
import { IconMessageCircleFilled } from '@tabler/icons-react'
import { useDocStatsStore } from '@/state/docStatsStore'
import { useWindowModeStore } from '@/state/windowModeStore'
import { askAi } from '@/lib/askAi'
import { cn } from '@/lib/utils'

// Shared Liquid-Glass surface: translucent + strong blur/saturation, with the
// canonical rim (layered inset highlights, brighter on top) instead of a flat
// border, plus a soft drop shadow. Kept subtle.
const GLASS = 'bg-background/55 backdrop-blur-xl backdrop-saturate-150'
const GLASS_SHADOW: React.CSSProperties = {
  boxShadow: [
    'inset 0 1px 0.5px rgba(255,255,255,0.22)',
    'inset 0 -1px 1px rgba(255,255,255,0.06)',
    '0 10px 28px -10px rgba(0,0,0,0.4)',
  ].join(', '),
}

export function DocStatsPanel() {
  const stats = useDocStatsStore((s) => s.stats)
  const compact = useWindowModeStore((s) => s.mode === 'compact')
  const [showChars, setShowChars] = useState(false)
  if (!stats) return null

  if (!compact) {
    return (
      <div className="pointer-events-none absolute bottom-3 right-3 z-10 select-none rounded-md border border-border/60 bg-background/80 px-2.5 py-1 text-footnote tabular-nums text-muted-foreground shadow-sm backdrop-blur">
        <span>{stats.words.toLocaleString()} words</span>
        <span className="mx-1.5 opacity-40">·</span>
        <span>{stats.chars.toLocaleString()} characters</span>
      </div>
    )
  }

  const label = showChars
    ? `${stats.chars.toLocaleString()} characters`
    : `${stats.words.toLocaleString()} words`

  return (
    <div
      className={cn(
        'pointer-events-none absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full p-1 text-sm',
        GLASS,
      )}
      style={GLASS_SHADOW}
    >
      <button
        type="button"
        onClick={askAi}
        aria-label="Ask AI"
        className="pointer-events-auto flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-muted-foreground transition-colors hover:bg-white/8 hover:text-foreground"
      >
        <IconMessageCircleFilled size={15} />
        Ask AI
      </button>
      <span aria-hidden className="h-4 w-px shrink-0 bg-white/10" />
      <button
        type="button"
        onClick={() => setShowChars((v) => !v)}
        aria-label="Toggle word / character count"
        className="pointer-events-auto select-none rounded-full px-3.5 py-1.5 tabular-nums text-muted-foreground transition-colors hover:bg-white/8 hover:text-foreground"
      >
        {label}
      </button>
    </div>
  )
}
