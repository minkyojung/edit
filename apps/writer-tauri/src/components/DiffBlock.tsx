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

export function DiffBlock({ lines, bare = false }: { lines: DiffLine[]; bare?: boolean }) {
  return (
    <pre
      className={cn(
        'overflow-x-auto p-0 font-mono text-[12px] leading-relaxed',
        // `bare` lets a host container (e.g. SuggestionCard) own the border so the
        // header / body / footer read as one flush block.
        !bare && 'rounded-md border border-border bg-background',
      )}
    >
      {lines.map((line, i) => (
        <div
          key={i}
          className={cn(
            // GitHub-style: no +/- glyph — the left accent bar + a soft row tint carry
            // add/remove. The TEXT keeps its syntax-token colours (no green/red override)
            // so the diff reads like coloured source.
            'border-l-2 px-3 py-0.5',
            line.kind === 'add'
              ? 'border-green-700/60 bg-green-500/[0.06]'
              : 'border-red-800/60 bg-red-500/[0.06]',
          )}
        >
          <span className="whitespace-pre-wrap break-words">
            {line.text.length === 0
              ? ' '
              : // Colour the markdown source tokens via CodeMirror's classifier so the
                // diff reads like source, not flat text.
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
