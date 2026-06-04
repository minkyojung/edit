// The single declarative contract for data visualizations. The AI (via a
// ```chart fence) and product features alike emit a ChartSpec; the DataViz
// engine renders it. The spec carries DATA ONLY — never colors or sizing — so
// the engine owns the look and every chart stays consistent. Keep this schema
// stable: it's the interface; the renderer behind it is swappable.

export interface ChartDatum {
  label: string
  value: number
}

export interface KpiItem {
  label: string
  value: string
  sub?: string
}

/** A named data series for multi-series charts (column). values[i] aligns with
 * xLabels[i]; a short/missing value is treated as 0 by the renderer. */
export interface ChartSeries {
  label: string
  values: number[]
}

export type ChartSpec =
  | { kind: 'donut'; title?: string; data: ChartDatum[] }
  | { kind: 'bar'; title?: string; data: ChartDatum[] }
  | {
      kind: 'column'
      title?: string
      xLabels: string[]
      series: ChartSeries[]
      stacked?: boolean
    }
  | { kind: 'kpi'; title?: string; items: KpiItem[] }

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v)

function parseData(raw: unknown): ChartDatum[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: ChartDatum[] = []
  for (const item of raw) {
    if (!isObject(item)) return null
    if (typeof item.label !== 'string' || !isFiniteNumber(item.value)) return null
    out.push({ label: item.label, value: item.value })
  }
  return out
}

function parseKpiItems(raw: unknown): KpiItem[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: KpiItem[] = []
  for (const item of raw) {
    if (!isObject(item)) return null
    if (typeof item.label !== 'string' || typeof item.value !== 'string') return null
    out.push({
      label: item.label,
      value: item.value,
      sub: typeof item.sub === 'string' ? item.sub : undefined,
    })
  }
  return out
}

function parseSeries(raw: unknown): ChartSeries[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: ChartSeries[] = []
  for (const item of raw) {
    if (!isObject(item)) return null
    if (typeof item.label !== 'string') return null
    if (!Array.isArray(item.values) || !item.values.every(isFiniteNumber)) return null
    out.push({ label: item.label, values: item.values })
  }
  return out
}

/** Validate an already-parsed object as a ChartSpec. Shared by parseChartSpec
 * (the ```chart fence path) and the viz composition parser, which validates
 * chart leaves through this same single source of truth. Returns null on any
 * malformed / incomplete input — never throws. */
export function parseChartObject(raw: Record<string, unknown>): ChartSpec | null {
  const title = typeof raw.title === 'string' ? raw.title : undefined

  switch (raw.kind) {
    case 'donut':
    case 'bar': {
      const data = parseData(raw.data)
      return data ? { kind: raw.kind, title, data } : null
    }
    case 'column': {
      const series = parseSeries(raw.series)
      const xLabels =
        Array.isArray(raw.xLabels) && raw.xLabels.every((x) => typeof x === 'string')
          ? (raw.xLabels as string[])
          : null
      if (!series || !xLabels || xLabels.length === 0) return null
      return {
        kind: 'column',
        title,
        xLabels,
        series,
        stacked: raw.stacked === true,
      }
    }
    case 'kpi': {
      const items = parseKpiItems(raw.items)
      return items ? { kind: 'kpi', title, items } : null
    }
    default:
      return null
  }
}

/** Parse + validate a ```chart fence body into a ChartSpec. Returns null on any
 * malformed / incomplete input (e.g. a half-streamed fence) so callers can fall
 * back to showing the source — never throws. */
export function parseChartSpec(jsonText: string): ChartSpec | null {
  let raw: unknown
  try {
    raw = JSON.parse(jsonText)
  } catch {
    return null
  }
  if (!isObject(raw)) return null
  return parseChartObject(raw)
}
