/**
 * Stage 2 — external edit resilience.
 *
 * Pass criteria (from the plan):
 *   - offset-only shifts (unrelated edits, prefix added): all `confident`
 *   - quote slightly modified: `degraded` via fuzzy match
 *   - quote rewritten: `orphaned` (no false positive on unrelated text)
 *   - Overall confident+degraded ≥ 80% → green-light Stage 3
 *
 * The second describe block sweeps fuzzy thresholds 0.65 / 0.75 / 0.85 so
 * the choice of threshold is informed by data instead of guessed.
 */

import { describe, expect, it } from 'vitest'

import { deserialize } from '../deserializer.js'
import { externalEditFixtures } from '../fixtures/index.js'
import type { ExternalEditFixture, MarkExpectation } from '../fixtures/types.js'
import { serialize } from '../serializer.js'
import type { ResolutionStatus, ResolvedMark } from '../types.js'

const DEFAULT_THRESHOLD = 0.75
const THRESHOLD_SWEEP = [0.65, 0.75, 0.85] as const

function runFixture(
  fixture: ExternalEditFixture,
  threshold: number,
): { resolvedById: Map<string, ResolvedMark> } {
  const { sidecar } = serialize(fixture.original)
  const result = deserialize(fixture.edited, sidecar, { fuzzyThreshold: threshold })
  const resolvedById = new Map(result.marks.map((m) => [m.id, m]))
  return { resolvedById }
}

function assertExpectation(
  fixture: ExternalEditFixture,
  expectation: MarkExpectation,
  resolved: ResolvedMark | undefined,
): void {
  expect(resolved, `${fixture.name}: mark ${expectation.markId} missing`).toBeDefined()
  expect(
    resolved!.status,
    `${fixture.name}: mark ${expectation.markId} expected ${expectation.expectedStatus}, got ${resolved!.status}`,
  ).toBe(expectation.expectedStatus)

  if (expectation.expectedStatus === 'orphaned') {
    expect(resolved!.range, `${fixture.name}: orphaned mark should have null range`).toBeNull()
    return
  }

  // For confident/degraded, range must be non-null.
  expect(resolved!.range, `${fixture.name}: non-orphaned mark missing range`).not.toBeNull()

  if (expectation.expectedRangeText) {
    const text = fixture.edited.slice(resolved!.range!.from, resolved!.range!.to)
    if (expectation.expectedStatus === 'confident') {
      expect(text, `${fixture.name}: confident mark must cover exact expected text`).toBe(
        expectation.expectedRangeText,
      )
    } else {
      // degraded — the resolved text should be the expected substring, but
      // since fuzzy matching slides over window sizes, allow small drift.
      // Hard assertion: the expected substring is fully contained, OR they
      // share ≥ 80% character overlap (sanity bound, not the algorithm's
      // threshold).
      const containsExpected = text.includes(expectation.expectedRangeText)
      const overlap = stringOverlapRatio(text, expectation.expectedRangeText)
      expect(
        containsExpected || overlap >= 0.8,
        `${fixture.name}: degraded mark range "${text}" doesn't reflect expected "${expectation.expectedRangeText}" (overlap ${overlap.toFixed(2)})`,
      ).toBe(true)
    }
  }
}

function stringOverlapRatio(a: string, b: string): number {
  const longer = a.length >= b.length ? a : b
  const shorter = a.length >= b.length ? b : a
  if (!longer.length) return 1
  let matched = 0
  for (const ch of shorter) {
    if (longer.includes(ch)) matched += 1
  }
  return matched / longer.length
}

describe('Stage 2: external edit resilience (default threshold 0.75)', () => {
  for (const fixture of externalEditFixtures) {
    describe(fixture.name, () => {
      it(fixture.description, () => {
        const { resolvedById } = runFixture(fixture, DEFAULT_THRESHOLD)
        for (const expectation of fixture.expectations) {
          assertExpectation(fixture, expectation, resolvedById.get(expectation.markId))
        }
      })
    })
  }

  it('aggregate: confident + degraded ≥ 80% across all marks', () => {
    let total = 0
    let alive = 0
    for (const fixture of externalEditFixtures) {
      const { resolvedById } = runFixture(fixture, DEFAULT_THRESHOLD)
      for (const [, mark] of resolvedById) {
        total += 1
        if (mark.status === 'confident' || mark.status === 'degraded') alive += 1
      }
    }
    const ratio = alive / total
    expect(ratio, `survival ratio ${(ratio * 100).toFixed(0)}% (need ≥ 80%)`).toBeGreaterThanOrEqual(
      0.8,
    )
  })
})

describe('Stage 2: fuzzy threshold sweep (informational)', () => {
  /**
   * Reports per-fixture status distribution at each threshold. Doesn't
   * hard-assert anything — the goal is to choose a threshold based on
   * which one preserves intentional edits without dragging marks onto
   * rewritten text.
   */
  it('logs status distribution for each fixture at thresholds 0.65 / 0.75 / 0.85', () => {
    type Row = {
      fixture: string
      threshold: number
      confident: number
      degraded: number
      orphaned: number
    }
    const rows: Row[] = []

    for (const fixture of externalEditFixtures) {
      for (const threshold of THRESHOLD_SWEEP) {
        const { resolvedById } = runFixture(fixture, threshold)
        const counts: Record<ResolutionStatus, number> = {
          confident: 0,
          degraded: 0,
          orphaned: 0,
        }
        for (const [, mark] of resolvedById) counts[mark.status] += 1
        rows.push({
          fixture: fixture.name,
          threshold,
          confident: counts.confident,
          degraded: counts.degraded,
          orphaned: counts.orphaned,
        })
      }
    }

    console.log('\n=== Stage 2 threshold sweep ===')
    console.log('fixture                              | threshold | confident | degraded | orphaned')
    console.log('-'.repeat(95))
    for (const r of rows) {
      console.log(
        `${r.fixture.padEnd(36)} | ${String(r.threshold).padEnd(9)} | ${String(r.confident).padEnd(9)} | ${String(r.degraded).padEnd(8)} | ${r.orphaned}`,
      )
    }
    expect(rows.length).toBe(externalEditFixtures.length * THRESHOLD_SWEEP.length)
  })
})
