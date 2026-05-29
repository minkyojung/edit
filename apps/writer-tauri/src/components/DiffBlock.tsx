// Git-style +/- diff renderer, shared across every review surface so a
// pending change reads the same whether the user sees it in the Review
// panel, a committed-change card, or inline in the chat answer.
//
// Pure presentational: takes `DiffLine[]` (see lib/pendingDiff →
// computePendingDiffLines) and renders each line with a `+`/`-` prefix,
// green for added, red for removed, in order so a modify reads
// `-old → +new` naturally.

import type { DiffLine } from '@/lib/git'
import { cn } from '@/lib/utils'

export function DiffBlock({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-background p-0 font-mono text-[12px] leading-relaxed">
      {lines.map((line, i) => (
        <div
          key={i}
          className={cn(
            'flex items-start gap-2 px-3 py-0.5',
            line.kind === 'add'
              ? 'bg-green-500/10 text-green-700 dark:text-green-300'
              : 'bg-red-500/10 text-destructive',
          )}
        >
          <span className="shrink-0 select-none opacity-70">
            {line.kind === 'add' ? '+' : '-'}
          </span>
          <span className="whitespace-pre-wrap break-words">
            {line.text.length === 0 ? ' ' : line.text}
          </span>
        </div>
      ))}
    </pre>
  )
}
