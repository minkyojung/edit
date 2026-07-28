// Headless proof for the table widget's anti-churn identity: `canonicalize` maps a
// GFM table SOURCE to the same normalized string `serialize` produces from the DOM, so
// `eq`/`updateDOM` recognize an own-commit as "unchanged" and KEEP the cell views
// (caret/IME survive) instead of tearing them down. What we assert here is the pure
// normalization contract; the focus-preservation itself needs the live editor.

import { describe, expect, it } from 'vitest'
import { canonicalize } from './editableTable'

const DELIM = '| --- | --- |'

describe('table canonicalize — anti-churn identity', () => {
  it('normalizes cell whitespace to single-spaced pipes', () => {
    expect(canonicalize('|a|b|\n|---|---|\n|1|2|', DELIM)).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |')
  })

  it('is idempotent (canonical of canonical is unchanged)', () => {
    const once = canonicalize('|Name|Value|\n|:--|--:|\n|  x |  y |', DELIM)
    expect(canonicalize(once, DELIM)).toBe(once)
  })

  it('treats whitespace-only differences as the SAME canonical (→ eq keeps DOM)', () => {
    const a = canonicalize('| a | b |\n|---|---|\n| 1 | 2 |', DELIM)
    const b = canonicalize('|a|b|\n|---|---|\n|1|2|', DELIM)
    expect(a).toBe(b)
  })

  it('preserves an escaped pipe inside a cell across the round-trip', () => {
    // A literal `|` in a cell is stored escaped as `\|`; canonicalize must keep it a
    // single cell (not split it) and re-emit the escape.
    const out = canonicalize('| a \\| b | c |\n|---|---|', DELIM)
    expect(out).toBe('| a \\| b | c |\n| --- | --- |')
  })

  it('handles a header-only table (no body rows)', () => {
    expect(canonicalize('|h1|h2|\n|---|---|', DELIM)).toBe('| h1 | h2 |\n| --- | --- |')
  })
})

// AUDIT C3 — why the synchronous commit-through is SAFE (and why deferring it would be
// wrong): an own-commit dispatches serialize(table) to the parent; the widget's
// updateDOM (serialize(dom) === this.canonical) then returns TRUE and CM REUSES the DOM
// instead of rebuilding it — which is what prevents a rebuild from destroying the very
// cell view whose update listener triggered the commit (the reentrancy hazard). That
// holds only while serialize's output is a canonicalize FIXED POINT. These pin that
// invariant across the shapes serialize emits, so a future normalization drift that
// would silently re-enable the reentrancy fails loudly here first. (Deferring the commit
// to a microtask, by contrast, would reopen the documented data-loss window where a
// rebuild between a cell edit and its commit re-renders from stale parent source.)
describe('table canonicalize — serialize output is a fixed point (C3 reentrancy guard)', () => {
  const raws = [
    '|a|b|\n|---|---|\n|1|2|', // plain
    '| a \\| b | c |\n|---|---|', // escaped pipe
    '|Name|Value|\n|:--|--:|\n|x|y|', // alignment markers
    '|only|header|\n|---|---|', // header-only
    '|a|b|\n|---|---|\n|line1<br>line2|z|', // in-cell <br> (multi-line cell)
  ]
  for (const raw of raws) {
    it(`canonical form is stable under re-canonicalization: ${JSON.stringify(raw)}`, () => {
      const once = canonicalize(raw, DELIM)
      expect(canonicalize(once, DELIM)).toBe(once) // fixed point → own-commit keeps DOM
    })
  }
})
