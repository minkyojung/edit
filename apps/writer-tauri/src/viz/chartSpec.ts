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

export type ChartSpec =
  | { kind: 'donut'; title?: string; data: ChartDatum[] }
  | { kind: 'bar'; title?: string; data: ChartDatum[] }
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

  const title = typeof raw.title === 'string' ? raw.title : undefined

  switch (raw.kind) {
    case 'donut':
    case 'bar': {
      const data = parseData(raw.data)
      return data ? { kind: raw.kind, title, data } : null
    }
    case 'kpi': {
      const items = parseKpiItems(raw.items)
      return items ? { kind: 'kpi', title, items } : null
    }
    default:
      return null
  }
}
