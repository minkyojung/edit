// Hover content for the context gauge — the `/context`-style breakdown.
//
// Header (Context  149.0k/200.0k) + a usage bar + a per-row list. STEP 2
// has only the totals, so the rows are a Used / Free split. STEP 3 feeds
// real `categories[]` from getContextUsage() and the same list renders the
// full breakdown (System tools / MCP tools (deferred) / Skills / …) with no
// change here. The warning colour trips at `autoCompactThreshold` when known
// (STEP 3) and a fixed 0.8 until then.

import type { ContextSnapshot } from '@/chat/types'
import { formatTokens } from '@/lib/formatTokens'
import { cn } from '@/lib/utils'

const WARN_FALLBACK = 0.8

interface Row {
  name: string
  frac: number
  isDeferred?: boolean
}

function buildRows(s: ContextSnapshot): Row[] {
  const max = s.maxTokens || 1
  if (s.categories && s.categories.length > 0) {
    return s.categories.map((c) => ({
      name: c.name,
      frac: c.tokens / max,
      isDeferred: c.isDeferred,
    }))
  }
  // STEP-2 fallback: only the totals are known → Used / Free split.
  const used = Math.min(s.totalTokens, max)
  const free = Math.max(0, max - used)
  return [
    { name: 'Used', frac: used / max },
    { name: 'Free space', frac: free / max },
  ]
}

export function ContextUsagePopover({ snapshot }: { snapshot: ContextSnapshot | null }) {
  if (!snapshot) {
    return (
      <div className="text-muted-foreground text-footnote">
        No data yet — send a message to see usage.
      </div>
    )
  }

  const max = snapshot.maxTokens || 1
  const usedFrac = Math.min(1, Math.max(0, snapshot.totalTokens / max))
  const threshold = snapshot.autoCompactThreshold ?? WARN_FALLBACK
  const warn = usedFrac >= threshold
  const rows = buildRows(snapshot)

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <span className="text-foreground font-medium">Context</span>
        <span className="text-muted-foreground text-footnote tabular-nums">
          {formatTokens(snapshot.totalTokens)}/{formatTokens(snapshot.maxTokens)}
        </span>
      </div>

      <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-300',
            warn ? 'bg-warning' : 'bg-foreground/70',
          )}
          style={{ width: `${usedFrac * 100}%` }}
        />
      </div>

      <div className="space-y-1">
        {rows.map((r) => (
          <div key={r.name} className="flex items-baseline justify-between text-footnote">
            <span className={cn('text-muted-foreground', r.isDeferred && 'opacity-70')}>
              {r.name}
            </span>
            <span className="text-muted-foreground tabular-nums">
              {(r.frac * 100).toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
