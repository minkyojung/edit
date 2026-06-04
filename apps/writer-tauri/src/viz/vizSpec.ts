// The composition contract: a recursive component tree the AI assembles and the
// VizRenderer draws. This is the superset of ChartSpec — a single chart is just
// a leaf. Layout nodes (stack / columns) nest leaves; leaves are charts (reused
// from chartSpec) plus stat / text / table.
//
// Like ChartSpec, a VizNode carries STRUCTURE + DATA ONLY — never colors, sizes,
// or fonts. Layout knobs (gap) are token enums, not pixels. The renderer owns
// the look, so any tree the AI builds stays in one visual family. The AI emits
// these via the edit_visualization tool (schema-shaped in the sidecar; see
// server.mjs), so it cannot escape into raw HTML; we re-validate here.

import {
  parseChartObject,
  type ChartDatum,
  type ChartSeries,
  type ChartSpec,
  type KpiItem,
} from './chartSpec'

export type VizGap = 'sm' | 'md' | 'lg'

// Layout nodes — arrange children. `stack` = vertical, `columns` = side by side.
export interface VizStack {
  type: 'stack'
  gap?: VizGap
  children: VizNode[]
}
export interface VizColumns {
  type: 'columns'
  gap?: VizGap
  children: VizNode[]
}

// Chart leaves — structurally the ChartSpec variants, keyed on `type` instead of
// `kind` so the whole tree shares one discriminant.
export interface VizDonut {
  type: 'donut'
  title?: string
  data: ChartDatum[]
}
export interface VizBar {
  type: 'bar'
  title?: string
  data: ChartDatum[]
}
export interface VizColumn {
  type: 'column'
  title?: string
  xLabels: string[]
  series: ChartSeries[]
  stacked?: boolean
}
export interface VizKpi {
  type: 'kpi'
  title?: string
  items: KpiItem[]
}

// Non-chart leaves.
export interface VizStat {
  type: 'stat'
  label: string
  value: string
  sub?: string
}
export interface VizText {
  type: 'text'
  value: string
  variant?: 'title' | 'body' | 'muted'
}
export interface VizTable {
  type: 'table'
  columns: string[]
  rows: (string | number)[][]
}

export type VizChartLeaf = VizDonut | VizBar | VizColumn | VizKpi
export type VizLeaf = VizChartLeaf | VizStat | VizText | VizTable
export type VizNode = VizStack | VizColumns | VizLeaf

// Bounds on tree size — a malformed or adversarial spec can't blow up render
// (the Server-Driven UI lesson: validate the payload, never trust depth).
const MAX_DEPTH = 6
const MAX_NODES = 100

const CHART_TYPES = new Set(['donut', 'bar', 'column', 'kpi'])

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v)

function parseGap(v: unknown): VizGap | undefined {
  return v === 'sm' || v === 'md' || v === 'lg' ? v : undefined
}

// ChartSpec (kind) → chart leaf (type). The two differ only by discriminant key.
function chartSpecToLeaf(spec: ChartSpec): VizChartLeaf {
  const { kind, ...rest } = spec
  return { type: kind, ...rest } as VizChartLeaf
}

function parseChildren(
  raw: unknown,
  depth: number,
  counter: { n: number },
): VizNode[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: VizNode[] = []
  for (const child of raw) {
    const node = parseNode(child, depth, counter)
    if (!node) return null
    out.push(node)
  }
  return out
}

function parseRows(raw: unknown): (string | number)[][] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: (string | number)[][] = []
  for (const row of raw) {
    if (!Array.isArray(row)) return null
    const cells: (string | number)[] = []
    for (const cell of row) {
      if (typeof cell === 'string' || isFiniteNumber(cell)) cells.push(cell)
      else return null
    }
    out.push(cells)
  }
  return out
}

function parseNode(raw: unknown, depth: number, counter: { n: number }): VizNode | null {
  if (!isObject(raw)) return null
  if (depth > MAX_DEPTH) return null
  if (++counter.n > MAX_NODES) return null

  const type = raw.type
  if (typeof type !== 'string') return null

  if (type === 'stack' || type === 'columns') {
    const children = parseChildren(raw.children, depth + 1, counter)
    if (!children) return null
    return { type, gap: parseGap(raw.gap), children }
  }

  if (CHART_TYPES.has(type)) {
    // Validate through the single chart source of truth (kind-keyed).
    const spec = parseChartObject({ ...raw, kind: type })
    return spec ? chartSpecToLeaf(spec) : null
  }

  if (type === 'stat') {
    if (typeof raw.label !== 'string' || typeof raw.value !== 'string') return null
    return {
      type,
      label: raw.label,
      value: raw.value,
      sub: typeof raw.sub === 'string' ? raw.sub : undefined,
    }
  }

  if (type === 'text') {
    if (typeof raw.value !== 'string') return null
    const variant =
      raw.variant === 'title' || raw.variant === 'body' || raw.variant === 'muted'
        ? raw.variant
        : undefined
    return { type, value: raw.value, variant }
  }

  if (type === 'table') {
    const columns =
      Array.isArray(raw.columns) && raw.columns.every((c) => typeof c === 'string')
        ? (raw.columns as string[])
        : null
    const rows = parseRows(raw.rows)
    if (!columns || columns.length === 0 || !rows) return null
    return { type, columns, rows }
  }

  return null
}

/** Parse + validate a ```viz fence body into a VizNode tree. Backward compatible:
 * a legacy single ChartSpec (keyed on `kind`, the old ```chart body) is accepted
 * and lifted into a chart leaf. Returns null on any malformed / incomplete input
 * (e.g. a half-streamed fence) so callers fall back to the source — never throws. */
export function parseVizSpec(jsonText: string): VizNode | null {
  let raw: unknown
  try {
    raw = JSON.parse(jsonText)
  } catch {
    return null
  }
  if (!isObject(raw)) return null

  // Legacy ChartSpec: has `kind`, no `type`. Lift to a leaf for uniform rendering.
  if (typeof raw.kind === 'string' && typeof raw.type !== 'string') {
    const spec = parseChartObject(raw)
    return spec ? chartSpecToLeaf(spec) : null
  }

  return parseNode(raw, 0, { n: 0 })
}
