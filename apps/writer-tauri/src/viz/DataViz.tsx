// The visualization engine: ChartSpec → themed render. These render in the
// HOST DOM (chat message / editor NodeView), as our own SVG/markup, so they use
// `var(--viz-cat-N)` directly and re-theme automatically with the app palette —
// no iframe, no token resolution, no security surface. The spec carries data
// only; color/sizing live here, so every chart looks like one family.

import type { ChartDatum, ChartSeries, ChartSpec, KpiItem } from './chartSpec'

// Categorical color for series index i (wraps after 6).
const cat = (i: number) => `var(--viz-cat-${(i % 6) + 1})`

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return Number.isInteger(n)
    ? n.toLocaleString()
    : n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function Title({ children }: { children: string }) {
  return (
    <figcaption className="mb-3 text-center text-sm font-semibold tracking-wide text-foreground">
      {children}
    </figcaption>
  )
}

function Legend({ data, total }: { data: ChartDatum[]; total: number }) {
  return (
    <ul className="mt-4 flex list-none flex-col gap-2 p-0">
      {data.map((d, i) => (
        <li key={`${d.label}-${i}`} className="flex items-center gap-2.5 text-sm">
          <span className="h-2.5 w-2.5 flex-none rounded-sm" style={{ background: cat(i) }} />
          <span className="flex-1 truncate font-medium text-foreground">{d.label}</span>
          <span className="flex-none tabular-nums text-muted-foreground">
            {formatNum(d.value)}
            {total > 0 ? ` · ${Math.round((d.value / total) * 100)}%` : ''}
          </span>
        </li>
      ))}
    </ul>
  )
}

function DonutChart({ title, data }: { title?: string; data: ChartDatum[] }) {
  const total = data.reduce((s, d) => s + Math.max(0, d.value), 0)
  const r = 70
  const circumference = 2 * Math.PI * r
  const GAP = 4 // circumference px between segments
  let acc = 0
  const segments = data.map((d, i) => {
    const frac = total > 0 ? Math.max(0, d.value) / total : 0
    const len = Math.max(0, frac * circumference - GAP)
    const seg = {
      color: cat(i),
      dash: `${len} ${circumference - len}`,
      offset: -acc,
    }
    acc += frac * circumference
    return seg
  })

  return (
    <figure className="m-0">
      {title && <Title>{title}</Title>}
      <div className="relative mx-auto" style={{ width: 200, height: 200 }}>
        <svg viewBox="0 0 200 200" className="h-full w-full -rotate-90">
          {segments.map((s, i) => (
            <circle
              key={i}
              cx={100}
              cy={100}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={26}
              strokeDasharray={s.dash}
              strokeDashoffset={s.offset}
            />
          ))}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Total</span>
          <span className="text-2xl font-bold tabular-nums text-foreground">
            {formatNum(total)}
          </span>
        </div>
      </div>
      <Legend data={data} total={total} />
    </figure>
  )
}

function BarChart({ title, data }: { title?: string; data: ChartDatum[] }) {
  const max = Math.max(...data.map((d) => Math.max(0, d.value)), 0) || 1
  return (
    <figure className="m-0">
      {title && <Title>{title}</Title>}
      <div className="flex flex-col gap-2.5">
        {data.map((d, i) => (
          <div key={`${d.label}-${i}`} className="flex items-center gap-3 text-sm">
            <span className="w-24 flex-none truncate text-muted-foreground">{d.label}</span>
            <div
              className="h-2.5 flex-1 overflow-hidden rounded-full"
              style={{ background: 'var(--muted)' }}
            >
              <div
                className="h-full rounded-full"
                style={{ width: `${(Math.max(0, d.value) / max) * 100}%`, background: cat(i) }}
              />
            </div>
            <span className="w-12 flex-none text-right tabular-nums text-foreground">
              {formatNum(d.value)}
            </span>
          </div>
        ))}
      </div>
    </figure>
  )
}

function KpiGrid({ title, items }: { title?: string; items: KpiItem[] }) {
  return (
    <figure className="m-0">
      {title && <Title>{title}</Title>}
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}
      >
        {items.map((it, i) => (
          <div
            key={`${it.label}-${i}`}
            className="flex flex-col gap-1 rounded-lg border bg-card p-3"
          >
            <span className="text-xl font-bold tabular-nums" style={{ color: cat(i) }}>
              {it.value}
            </span>
            <span className="text-xs text-muted-foreground">{it.label}</span>
            {it.sub && <span className="text-[11px] text-muted-foreground/70">{it.sub}</span>}
          </div>
        ))}
      </div>
    </figure>
  )
}

// Legend for multi-series charts: one swatch+label per series.
function SeriesLegend({ series }: { series: ChartSeries[] }) {
  return (
    <ul className="mb-2 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs">
      {series.map((s, i) => (
        <li key={`${s.label}-${i}`} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 flex-none rounded-sm" style={{ background: cat(i) }} />
          <span className="text-muted-foreground">{s.label}</span>
        </li>
      ))}
    </ul>
  )
}

const COLUMN_HEIGHT = 120

// Multi-series columns are always stacked (the common case — e.g. event counts
// by kind per hour). The `stacked` spec flag is reserved; grouped bars would
// need side-by-side sub-bars and aren't needed yet.
function ColumnChart({
  title,
  xLabels,
  series,
}: {
  title?: string
  xLabels: string[]
  series: ChartSeries[]
}) {
  const valueAt = (s: ChartSeries, xi: number) => Math.max(0, Number(s.values[xi]) || 0)
  // y-scale denominator: the tallest stack across all x positions.
  const max =
    Math.max(
      ...xLabels.map((_, xi) => series.reduce((sum, s) => sum + valueAt(s, xi), 0)),
      0,
    ) || 1
  // Sparse x labels (~6 max) so a 24-hour axis doesn't crowd.
  const step = Math.max(1, Math.ceil(xLabels.length / 6))

  return (
    <figure className="m-0">
      {title && <Title>{title}</Title>}
      {series.length > 1 && <SeriesLegend series={series} />}
      <div className="flex items-end gap-[2px]" style={{ height: COLUMN_HEIGHT }}>
        {xLabels.map((label, xi) => (
          <div
            key={`${label}-${xi}`}
            className="flex flex-1 flex-col-reverse overflow-hidden rounded-t-sm"
            title={label}
          >
            {series.map((s, si) => {
              const h = (valueAt(s, xi) / max) * COLUMN_HEIGHT
              if (h <= 0) return null
              return (
                <div key={`${s.label}-${si}`} style={{ height: h, background: cat(si) }} />
              )
            })}
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[2px]">
        {xLabels.map((label, xi) => (
          <span
            key={`${label}-${xi}`}
            className="flex-1 text-center text-[10px] tabular-nums text-muted-foreground"
          >
            {xi % step === 0 ? label : ''}
          </span>
        ))}
      </div>
    </figure>
  )
}

/** Render a validated ChartSpec. Source-agnostic — used as the chart-leaf
 * renderer by VizRenderer and by product features that pass a spec directly. */
export function DataViz({ spec }: { spec: ChartSpec }) {
  switch (spec.kind) {
    case 'donut':
      return <DonutChart title={spec.title} data={spec.data} />
    case 'bar':
      return <BarChart title={spec.title} data={spec.data} />
    case 'column':
      return <ColumnChart title={spec.title} xLabels={spec.xLabels} series={spec.series} />
    case 'kpi':
      return <KpiGrid title={spec.title} items={spec.items} />
  }
}
