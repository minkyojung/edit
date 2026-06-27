// Floating word/character readout — sits just off the editor's bottom-right
// corner and updates live as you type. Reads useDocStatsStore (published by
// CmEditor on every doc change), so it holds no editor reference. Hidden when
// no doc is open. Pointer-events-none: a glance-only readout, never in the way.
import { useDocStatsStore } from '@/state/docStatsStore'
import { useWindowModeStore } from '@/state/windowModeStore'
import { cn } from '@/lib/utils'

export function DocStatsPanel() {
  const stats = useDocStatsStore((s) => s.stats)
  const compact = useWindowModeStore((s) => s.mode === 'compact')
  if (!stats) return null
  return (
    <div
      className={cn(
        'pointer-events-none absolute bottom-3 right-3 z-10 select-none tabular-nums text-footnote text-muted-foreground backdrop-blur',
        // Compact gets the macOS Tahoe capsule: full radius, generous padding,
        // a soft ring instead of a hard border. Full mode keeps the compact
        // bordered tag.
        compact
          ? 'rounded-full border-[0.5px] border-border bg-background/65 px-4 py-2 shadow-md'
          : 'rounded-md border border-border/60 bg-background/80 px-2.5 py-1 shadow-sm',
      )}
    >
      <span>{stats.words.toLocaleString()} words</span>
      <span className={cn('opacity-40', compact ? 'mx-2' : 'mx-1.5')}>·</span>
      <span>{stats.chars.toLocaleString()} characters</span>
    </div>
  )
}
