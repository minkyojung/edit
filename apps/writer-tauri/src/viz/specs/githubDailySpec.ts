// Built-in Vega-Lite spec for the daily GitHub-activity card — the "frame".
// It is colour-agnostic and data-agnostic: VegaBlock injects the active
// palette (config.range/axis) and the day's rows ({ hour, kind }) at
// render time, so the same spec stays fixed while the data updates live
// (the "Excel chart" model the user asked for). Swapping this object — or
// later letting the AI author one — changes the chart without touching the
// renderer or the card.
//
// v1 chart: hour-of-day (0–23) stacked bar, coloured by event kind.

export const githubDailySpec = {
  $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
  width: 'container',
  height: 110,
  mark: { type: 'bar', cornerRadiusEnd: 1 },
  encoding: {
    x: {
      field: 'hour',
      type: 'ordinal',
      // Force the full day so the axis reads as a timeline even on quiet days.
      scale: { domain: Array.from({ length: 24 }, (_, i) => i) },
      axis: {
        title: null,
        values: [0, 6, 12, 18],
        labelExpr: "datum.value + 'h'",
        labelAngle: 0,
        grid: false,
      },
    },
    y: {
      aggregate: 'count',
      type: 'quantitative',
      axis: { title: null, tickMinStep: 1, grid: false },
    },
    color: {
      field: 'kind',
      type: 'nominal',
      scale: { domain: ['commit', 'pr_opened', 'pr_merged'] },
      legend: {
        title: null,
        orient: 'top',
        direction: 'horizontal',
        labelExpr:
          "datum.label === 'pr_merged' ? 'PR merged' : datum.label === 'pr_opened' ? 'PR opened' : 'commit'",
      },
    },
  },
} as const
