/** Human-readable wall-clock duration. Stays terse so it sits unobtrusively
 * under the message — sub-second is shown to one decimal, single-minute uses
 * a single integer minute, and longer waits split into m+s. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return sec === 0 ? `${min}m` : `${min}m ${sec}s`
}
