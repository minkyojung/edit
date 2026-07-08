// Lightweight fzf-style fuzzy scorer for filename / title pickers. Returns a
// score (higher = better) or -1 when `query` is not a subsequence of `target`.
// No dependencies — good enough for the @-mention and command pickers.
//
// Heuristics: every query char must appear in order; contiguous runs and
// matches at a word boundary (start, space, /, -, _) score higher; earlier
// matches and shorter targets get a small edge.
export function fuzzyScore(query: string, target: string): number {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  let score = 0
  let from = 0
  let prev = -2
  for (let i = 0; i < q.length; i++) {
    const at = t.indexOf(q[i], from)
    if (at === -1) return -1
    score += 1
    if (at === prev + 1) score += 3 // contiguous
    const before = at === 0 ? '' : t[at - 1]
    if (at === 0 || before === ' ' || before === '/' || before === '-' || before === '_') {
      score += 2 // word boundary
    }
    score -= at * 0.01 // earlier is better
    prev = at
    from = at + 1
  }
  return score - t.length * 0.001 // prefer shorter targets
}
