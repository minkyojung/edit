// Floating word/character readout — sits just off the editor's bottom-right
// corner and updates live as you type. Reads useDocStatsStore (published by
// CmEditor on every doc change), so it holds no editor reference. Hidden when
// no doc is open. Pointer-events-none: a glance-only readout, never in the way.
import { useDocStatsStore } from '@/state/docStatsStore'

export function DocStatsPanel() {
  const stats = useDocStatsStore((s) => s.stats)
  if (!stats) return null
  return (
    <div className="pointer-events-none absolute bottom-3 right-3 z-10 select-none rounded-md border border-border/60 bg-background/80 px-2.5 py-1 text-footnote tabular-nums text-muted-foreground shadow-sm backdrop-blur">
      <span>{stats.words.toLocaleString()} words</span>
      <span className="mx-1.5 opacity-40">·</span>
      <span>{stats.chars.toLocaleString()} characters</span>
    </div>
  )
}
