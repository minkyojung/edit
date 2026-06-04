// Vega-Lite renderer — the third member of the viz family (alongside
// MermaidBlock / ArtifactBlock). Unlike those, Vega keeps the chart shape
// (spec) and the data SEPARATE, so the caller can hold a fixed spec and
// feed live data — the daily GitHub card passes events.db rows that change
// on every sync.
//
// Mirrors MermaidBlock's lifecycle: lazy-import the heavy lib on first use,
// re-render on a palette switch (usePaletteSignal), and fall back quietly
// on failure — a visualization must never break the surrounding doc.

import { useEffect, useRef, useState } from 'react'
import type { VisualizationSpec } from 'vega-embed'
import { usePaletteSignal } from './usePaletteSignal'
import { resolveFontFamily, resolveTokens } from './resolveTokens'

type Row = Record<string, unknown>

// vega-embed is heavy (vega + vega-lite + d3). Load it once, lazily, and
// reuse the module promise — same policy as MermaidBlock.
type EmbedFn = (typeof import('vega-embed'))['default']
let embedPromise: Promise<EmbedFn> | null = null
function loadEmbed(): Promise<EmbedFn> {
  if (!embedPromise) embedPromise = import('vega-embed').then((m) => m.default)
  return embedPromise
}

/** Map the active palette onto Vega's config so axes/legend/bars match the
 * app theme. resolveTokens reads computed styles off <html>, so the values
 * already reflect the current palette + light/dark. */
function buildConfig(): Record<string, unknown> {
  const t = resolveTokens([
    '--foreground',
    '--muted-foreground',
    '--border',
    '--accent',
    '--primary',
  ])
  const font = resolveFontFamily()
  const muted = t['--muted-foreground']
  const axis = {
    labelColor: muted,
    titleColor: muted,
    gridColor: t['--border'],
    domainColor: t['--border'],
    tickColor: t['--border'],
    labelFont: font,
    titleFont: font,
    labelFontSize: 9,
  }
  return {
    background: null,
    font,
    axis,
    legend: {
      labelColor: muted,
      titleColor: muted,
      labelFont: font,
      labelFontSize: 10,
      symbolSize: 50,
    },
    view: { stroke: null },
    // Category colours for the `kind` scale domain (commit, opened, merged).
    range: {
      category: [muted, t['--foreground'], t['--accent'] ?? t['--primary']],
    },
  }
}

export function VegaBlock({
  spec,
  data,
}: {
  spec: object
  data: Row[]
}) {
  const ref = useRef<HTMLDivElement>(null)
  const signal = usePaletteSignal()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const host = ref.current
    if (!host) return
    let cancelled = false
    let view: { finalize: () => void } | null = null
    setFailed(false)

    void (async () => {
      try {
        const embed = await loadEmbed()
        if (cancelled || !ref.current) return
        // Merge the fixed spec with the live data slot, then cast once —
        // the VisualizationSpec union types `data` as Data[] in some
        // members, which a structural spread can't satisfy.
        const fullSpec = {
          ...(spec as Record<string, unknown>),
          data: { values: data },
        } as unknown as VisualizationSpec
        const result = await embed(ref.current, fullSpec, {
          actions: false,
          renderer: 'svg',
          config: buildConfig(),
        })
        if (cancelled) {
          result.view.finalize()
          return
        }
        view = result.view
      } catch (e) {
        console.warn('[vega] render failed', e)
        if (!cancelled) setFailed(true)
      }
    })()

    return () => {
      cancelled = true
      view?.finalize()
    }
  }, [spec, data, signal])

  if (failed) {
    return (
      <div className="mt-1 text-[11px] text-muted-foreground/60">
        차트를 그리지 못했습니다
      </div>
    )
  }
  return <div ref={ref} className="mt-1 w-full" />
}
