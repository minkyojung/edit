// Short relative-time string for glanceable UI ("3m ago", "2h ago",
// "yesterday", "2w ago", or an absolute date past ~5 weeks).
//
// Why hand-rolled and not Intl.RelativeTimeFormat: the design has
// deliberate non-Intl behaviors:
//   - "just now" instead of "0 minutes ago" — the dead zone under a
//     minute should read as "no time worth quantifying", not "zero".
//   - "yesterday" instead of "1 day ago" — the calendar-day name is
//     what people actually use in speech for that bucket.
//   - past ~5 weeks the absolute date ("Jan 5, 2026") is more useful
//     than "12w ago" — for old items, the date itself is what the
//     reader is trying to recall.
//
// Accepts ISO string, ms timestamp, or Date — callers historically
// had whichever was in hand (provenance marks store ISO, archived
// docs store ms). One helper for all of them.

export function formatRelative(input: string | number | Date): string {
  const then = toMs(input)
  if (then === null) return 'recently'

  const diff = Date.now() - then
  const m = Math.round(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`

  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`

  const d = Math.round(h / 24)
  if (d === 1) return 'yesterday'
  if (d < 7) return `${d}d ago`

  const w = Math.round(d / 7)
  if (w < 5) return `${w}w ago`

  return new Date(then).toLocaleDateString()
}

function toMs(input: string | number | Date): number | null {
  if (input instanceof Date) {
    const t = input.getTime()
    return Number.isNaN(t) ? null : t
  }
  if (typeof input === 'number') {
    return Number.isFinite(input) ? input : null
  }
  const t = new Date(input).getTime()
  return Number.isNaN(t) ? null : t
}
