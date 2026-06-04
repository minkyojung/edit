import { useMemo } from 'react'
import type { BundledLanguage } from 'shiki'
import { CodeBlock } from '@/components/ai-elements/code-block'
import { parseVizSpec } from './vizSpec'
import { VizRenderer } from './VizRenderer'
import { insertVizIntoDoc } from './insertIntoDoc'

/** Render a ```chart fenced block as a themed visualization. The body is a
 * VizNode tree — a single chart leaf, or a composed dashboard (stack/columns of
 * charts + stat/text/table) — validated by parseVizSpec. A legacy single
 * ChartSpec body still parses (backward compatible), so old documents render
 * unchanged. While streaming or on an invalid/half-written spec it falls back to
 * the raw source as a code block — never breaks the surface. No iframe: the
 * render is our own host-DOM markup, so it re-themes for free and carries no
 * security surface. */
export function VizBlock({
  code,
  isStreaming,
  embedded = false,
}: {
  code: string
  isStreaming: boolean
  // When rendered inside the editor NodeView the chart already lives in the
  // doc, so suppress the chat-only "본문에 삽입" affordance (the NodeView
  // toolbar owns edit/insert there).
  embedded?: boolean
}) {
  const node = useMemo(() => (isStreaming ? null : parseVizSpec(code)), [code, isStreaming])

  if (!node) {
    return <CodeBlock code={code} language={'json' as BundledLanguage} />
  }

  return (
    <div className="group relative my-2 rounded-md border bg-background p-4">
      <VizRenderer node={node} />
      {!embedded && (
        <button
          type="button"
          onClick={() => void insertVizIntoDoc('chart', code)}
          className="absolute right-1 top-1 rounded bg-background/80 px-1.5 py-0.5 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
        >
          본문에 삽입
        </button>
      )}
    </div>
  )
}
