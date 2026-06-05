// PM CONTROL run of the anchor-stability harness (Phase 0).
//
// Produces the baseline the CodeMirror prototype is later measured
// against:
//   1. deterministic regression cases (named scripts → exact expectations)
//   2. seeded random pass-rate per fixture (unrelated edits must not move
//      the anchor) — reported split into the PM-position bucket vs the
//      disk-derived (hunks) bucket so the eventual PM↔CM comparison stays
//      apples-to-apples.

import { describe, expect, it } from 'vitest'
import { fixtures } from './anchorStability.fixtures'
import { pmAdapter, mdToTestDoc } from './adapters/pmAdapter'
import { runAccept, runRandomTrials, runScript } from './anchorStability.harness'
import { computePendingHunks } from '@/lib/computePendingHunks'

const RANDOM = { trials: 50, opsPerTrial: 8, seed: 0x5eed }

describe('anchor stability — deterministic regression', () => {
  for (const fx of fixtures) {
    it(fx.name, () => {
      const { check } = runScript(pmAdapter, fx, fx.userEditScript ?? [])
      expect(check.pass, check.reason).toBe(true)
    })
  }

  it('unplaced fixture starts unplaced (before the promoting edit)', () => {
    const fx = fixtures.find((f) => f.group === 'unplaced')!
    const { probe } = runScript(pmAdapter, fx, [])
    expect(probe.status).toBe('unplaced')
  })
})

describe('accept fidelity (secondary)', () => {
  for (const fx of fixtures.filter((f) => f.expectedBody !== undefined)) {
    it(fx.name, () => {
      expect(runAccept(pmAdapter, fx, [])).toBe(fx.expectedBody)
    })
  }
})

describe('hunks guard (risk #2 — doc structure must match remark)', () => {
  for (const fx of fixtures.filter((f) => f.group === 'hunks' && f.initialBody)) {
    it(fx.name, () => {
      const doc = mdToTestDoc(fx.initialBody)
      const after = fx.edit.after ?? ''
      expect(computePendingHunks(fx.initialBody, after, doc)).not.toBeNull()
    })
  }
})

describe('anchor stability — seeded random pass-rate', () => {
  const report: Array<{ name: string; bucket: string; rate: string }> = []
  const candidates = fixtures.filter((f) => (f.safeTokens?.length ?? 0) > 0)

  for (const fx of candidates) {
    it(`${fx.name} — unrelated edits preserve the anchor`, () => {
      const r = runRandomTrials(pmAdapter, fx, RANDOM)
      const bucket = fx.group === 'hunks' ? 'disk-derived' : 'pm-position'
      report.push({
        name: fx.name,
        bucket,
        rate: `${r.passes}/${r.total}`,
      })
      expect(
        r.passes,
        r.firstFailure ? `first failure: ${r.firstFailure.reason}` : 'ok',
      ).toBe(r.total)
    })
  }

  it('BASELINE summary (PM control)', () => {
    // Printed so the numbers land in the test output for the record.
    console.log(
      '\n[anchor-stability PM baseline]\n' +
        report.map((r) => `  ${r.bucket.padEnd(12)} ${r.rate.padStart(7)}  ${r.name}`).join('\n') +
        '\n',
    )
    expect(report.length).toBeGreaterThan(0)
  })
})
