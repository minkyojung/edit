/** Format a positive seconds count for the rate-limit countdown. Sub-minute
 * stays as `12s`; longer waits split into `Xm Ys` so a 2-hour reset doesn't
 * show as "7384s". The rendered widths stay small so the error footer
 * doesn't reflow as the count ticks. */
export function formatCountdown(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`
  const h = Math.floor(m / 60)
  const mm = m % 60
  return mm === 0 ? `${h}h` : `${h}h ${mm}m`
}
