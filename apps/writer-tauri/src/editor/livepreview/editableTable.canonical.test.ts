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
