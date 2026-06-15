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
import { highlightMarkdownLine } from '@/lib/highlightMarkdown'
import './diffHighlight.css'

export function DiffBlock({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-background p-0 font-mono text-[12px] leading-relaxed">
      {lines.map((line, i) => (
        <div
          key={i}
          className={cn(
            // Left accent bar (border-l-2) + tinted row, matching the review-card look.
            'flex items-start gap-2 border-l-2 px-3 py-0.5',
            line.kind === 'add'
              ? 'border-green-500 bg-green-500/10 text-green-700 dark:text-green-300'
              : 'border-red-500 bg-red-500/10 text-destructive',
          )}
        >
          <span className="shrink-0 select-none opacity-70">
            {line.kind === 'add' ? '+' : '-'}
          </span>
          <span className="whitespace-pre-wrap break-words">
            {line.text.length === 0
              ? ' '
              : // Colour the markdown source tokens via CodeMirror's classifier so the
                // diff reads like source, not flat text. The row's add/remove colour
                // stays as the default; tok-* classes override only matched tokens.
                highlightMarkdownLine(line.text).map((seg, j) =>
                  seg.cls ? (
                    <span key={j} className={seg.cls}>
                      {seg.text}
                    </span>
                  ) : (
                    <span key={j}>{seg.text}</span>
                  ),
                )}
          </span>
        </div>
      ))}
    </pre>
  )
}
