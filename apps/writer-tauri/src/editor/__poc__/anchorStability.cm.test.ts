// CodeMirror run of the anchor-stability harness — the SAME fixtures and
// harness as the PM control (anchorStability.pm.test.ts), driven through
// cmAdapter. Side-by-side, the two test files answer "does CM hold the
// anchor as well as PM?" with one number.

import { describe, expect, it } from 'vitest'
import { fixtures } from './anchorStability.fixtures'
import { cmAdapter } from './adapters/cmAdapter'
import { runAccept, runRandomTrials, runScript } from './anchorStability.harness'

const RANDOM = { trials: 50, opsPerTrial: 8, seed: 0x5eed }

describe('CM anchor stability — deterministic regression', () => {
  for (const fx of fixtures) {
    it(fx.name, () => {
      const { check } = runScript(cmAdapter, fx, fx.userEditScript ?? [])
      expect(check.pass, check.reason).toBe(true)
    })
  }

  it('unplaced fixture starts unplaced (before the promoting edit)', () => {
    const fx = fixtures.find((f) => f.group === 'unplaced')!
    const { probe } = runScript(cmAdapter, fx, [])
    expect(probe.status).toBe('unplaced')
  })
})

describe('CM accept fidelity (secondary)', () => {
  for (const fx of fixtures.filter((f) => f.expectedBody !== undefined)) {
    it(fx.name, () => {
      expect(runAccept(cmAdapter, fx, [])).toBe(fx.expectedBody)
    })
  }
})

describe('CM anchor stability — seeded random pass-rate', () => {
  const report: Array<{ name: string; bucket: string; rate: string }> = []
  const candidates = fixtures.filter((f) => (f.safeTokens?.length ?? 0) > 0)

  for (const fx of candidates) {
    it(`${fx.name} — unrelated edits preserve the anchor`, () => {
      const r = runRandomTrials(cmAdapter, fx, RANDOM)
      report.push({
        name: fx.name,
        bucket: fx.group === 'hunks' ? 'disk-derived' : 'pm-position',
        rate: `${r.passes}/${r.total}`,
      })
      expect(
        r.passes,
        r.firstFailure ? `first failure: ${r.firstFailure.reason}` : 'ok',
      ).toBe(r.total)
    })
  }

  it('CM BASELINE summary', () => {
    console.log(
      '\n[anchor-stability CM]\n' +
        report.map((r) => `  ${r.bucket.padEnd(12)} ${r.rate.padStart(7)}  ${r.name}`).join('\n') +
        '\n',
    )
    expect(report.length).toBeGreaterThan(0)
  })
})
