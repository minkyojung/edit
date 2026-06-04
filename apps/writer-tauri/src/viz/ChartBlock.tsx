import { useMemo } from 'react'
import type { BundledLanguage } from 'shiki'
import { CodeBlock } from '@/components/ai-elements/code-block'
import { parseChartSpec } from './chartSpec'
import { DataViz } from './DataViz'

/** Render a ```chart fenced block (a JSON ChartSpec) as a themed chart. Mirrors
 * MermaidBlock's lifecycle: while streaming or on an invalid/half-written spec
 * it falls back to the raw source as a code block — never breaks the surface.
 * Unlike artifacts there's no iframe: the chart is our own SVG in the host DOM,
 * so it re-themes for free and carries no security surface. */
export function ChartBlock({
  code,
  isStreaming,
  embedded = false,
}: {
  code: string
  isStreaming: boolean
  // Symmetry with Mermaid/Artifact blocks; reserved for future chat-only
  // affordances (the editor NodeView toolbar already owns edit/insert there).
  embedded?: boolean
}) {
  void embedded
  const spec = useMemo(() => (isStreaming ? null : parseChartSpec(code)), [code, isStreaming])

  if (!spec) {
    return <CodeBlock code={code} language={'json' as BundledLanguage} />
  }

  return (
    <div className="my-2 rounded-md border bg-background p-4">
      <DataViz spec={spec} />
    </div>
  )
}
