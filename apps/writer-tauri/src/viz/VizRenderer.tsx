// The recursive renderer for a VizNode tree. Layout nodes become flex
// containers with token gaps; chart leaves delegate to the existing DataViz
// engine; stat / text / table are small leaves that reuse the same tokens
// (--viz-cat, bg-card, border, muted-foreground). Nothing here reads color or
// size from the spec — the look lives entirely in this file, so any tree the AI
// assembles renders as one visual family.

import type { ChartSpec } from './chartSpec'
import { DataViz } from './DataViz'
import type { VizChartLeaf, VizNode, VizStat, VizTable, VizText } from './vizSpec'

const GAP_CLASS: Record<string, string> = {
  sm: 'gap-2',
  md: 'gap-4',
  lg: 'gap-6',
}
const gapClass = (gap?: string) => GAP_CLASS[gap ?? 'md'] ?? GAP_CLASS.md

// chart leaf (type) → ChartSpec (kind), the shape DataViz renders.
function leafToChartSpec(node: VizChartLeaf): ChartSpec {
  const { type, ...rest } = node
  return { kind: type, ...rest } as ChartSpec
}

function Stat({ node }: { node: VizStat }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-3">
      <span className="text-2xl font-bold tabular-nums text-foreground">{node.value}</span>
      <span className="text-footnote text-muted-foreground">{node.label}</span>
      {node.sub && <span className="text-caption text-muted-foreground/70">{node.sub}</span>}
    </div>
  )
}

const TEXT_CLASS: Record<string, string> = {
  title: 'text-body font-semibold tracking-wide text-foreground',
  body: 'text-body text-foreground',
  muted: 'text-footnote text-muted-foreground',
}

function Text({ node }: { node: VizText }) {
  return <p className={`m-0 ${TEXT_CLASS[node.variant ?? 'body'] ?? TEXT_CLASS.body}`}>{node.value}</p>
}

function Table({ node }: { node: VizTable }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-body">
        <thead>
          <tr>
            {node.columns.map((c, i) => (
              <th
                key={`${c}-${i}`}
                className="border-b px-2 py-1.5 text-left font-medium text-muted-foreground"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {node.rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci} className="border-b px-2 py-1.5 tabular-nums text-foreground">
                  {String(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function VizNodeView({ node }: { node: VizNode }) {
  switch (node.type) {
    case 'stack':
      return (
        <div className={`flex flex-col ${gapClass(node.gap)}`}>
          {node.children.map((child, i) => (
            <VizNodeView key={i} node={child} />
          ))}
        </div>
      )
    case 'columns':
      // flex-wrap + min width so a row of cards collapses gracefully in the
      // narrow chat panel instead of crushing each child.
      return (
        <div className={`flex flex-row flex-wrap ${gapClass(node.gap)}`}>
          {node.children.map((child, i) => (
            <div key={i} className="min-w-[180px] flex-1">
              <VizNodeView node={child} />
            </div>
          ))}
        </div>
      )
    case 'stat':
      return <Stat node={node} />
    case 'text':
      return <Text node={node} />
    case 'table':
      return <Table node={node} />
    default:
      // donut | bar | column | kpi — the chart leaves.
      return <DataViz spec={leafToChartSpec(node)} />
  }
}

/** Render a validated VizNode tree. Source-agnostic — used by the ```viz fence
 * (via VizBlock) and by product features that pass a tree directly. */
export function VizRenderer({ node }: { node: VizNode }) {
  return <VizNodeView node={node} />
}
