// Compact token-count formatter for the context gauge.
//   1346     → "1.3k"
//   149000   → "149.0k"
//   1_000_000 → "1.0M"
// Sub-1k values render as a plain integer. Mirrors the `149.0k/1.0M`
// shape Claude Code's /context header uses.

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(Math.round(n))
}
