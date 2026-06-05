// Editor-NEUTRAL harness. Drives any EditorAdapter through a fixture and
// reports whether the anchor stayed correctly placed. Knows nothing about
// ProseMirror or CodeMirror — that lives entirely in the adapters.

import type { AnchorProbe, EditorAdapter, Fixture, Op } from './anchorStability.types'
import { mulberry32, pick } from './prng'

export interface CheckResult {
  pass: boolean
  reason: string
}

/** Assert the probe against whichever expectations the fixture declares.
 * Unset expectations are not checked. */
export function checkProbe(fixture: Fixture, probe: AnchorProbe): CheckResult {
  if (fixture.expectedStatus !== undefined && probe.status !== fixture.expectedStatus) {
    return { pass: false, reason: `status ${probe.status} != ${fixture.expectedStatus}` }
  }
  if (fixture.expectedTargetText !== undefined && probe.targetText !== fixture.expectedTargetText) {
    return {
      pass: false,
      reason: `target ${JSON.stringify(probe.targetText)} != ${JSON.stringify(fixture.expectedTargetText)}`,
    }
  }
  if (fixture.expectedTextBeforeInsert !== undefined) {
    const t = probe.textBeforeInsert
    if (!t || !t.endsWith(fixture.expectedTextBeforeInsert)) {
      return {
        pass: false,
        reason: `textBeforeInsert ${JSON.stringify(t)} !endsWith ${JSON.stringify(fixture.expectedTextBeforeInsert)}`,
      }
    }
  }
  return { pass: true, reason: 'ok' }
}

/** init → apply each op → probe → dispose. Returns the placement check. */
export function runScript<H>(
  adapter: EditorAdapter<H>,
  fixture: Fixture,
  script: Op[],
): { probe: AnchorProbe; check: CheckResult } {
  let h = adapter.init(fixture)
  try {
    for (const op of script) h = adapter.applyUserOp(h, op)
    const probe = adapter.probe(h)
    return { probe, check: checkProbe(fixture, probe) }
  } finally {
    adapter.dispose(h)
  }
}

/** init → apply each op → accept → dispose. Returns the final body. */
export function runAccept<H>(
  adapter: EditorAdapter<H>,
  fixture: Fixture,
  script: Op[],
): string {
  let h = adapter.init(fixture)
  try {
    for (const op of script) h = adapter.applyUserOp(h, op)
    return adapter.accept(h)
  } finally {
    adapter.dispose(h)
  }
}

// Small, fixed alphabet of inserted text for random scripts — kept
// distinct from fixture content so it can't accidentally create a
// second copy of an anchor.
const NOISE = ['Z', 'qq', ' (note)', '123', '—']

/** Build a random script of `ops` edits that touch ONLY the fixture's
 * declared safeTokens (text away from the anchor). The point is to prove
 * unrelated edits don't disturb the anchor, so we never target the
 * anchor region. */
export function generateRandomScript(
  rng: () => number,
  fixture: Fixture,
  ops: number,
): Op[] {
  const tokens = fixture.safeTokens ?? []
  if (tokens.length === 0) return []
  const out: Op[] = []
  for (let i = 0; i < ops; i++) {
    const find = pick(rng, tokens)
    const r = rng()
    if (r < 0.5) {
      out.push({
        kind: 'insertText',
        find,
        where: rng() < 0.5 ? 'before' : 'after',
        text: pick(rng, NOISE),
      })
    } else if (r < 0.8) {
      // Keep `find` as a prefix so later ops on the same token still hit.
      out.push({ kind: 'replaceText', find, text: find + pick(rng, NOISE) })
    } else {
      out.push({ kind: 'deleteText', find })
    }
  }
  return out
}

export interface RandomResult {
  passes: number
  total: number
  firstFailure?: { script: Op[]; reason: string }
}

/** Run `trials` random scripts (seeded) and report the pass-rate. A pass
 * = the anchor still satisfies the fixture's expectations after the
 * unrelated edits. */
export function runRandomTrials<H>(
  adapter: EditorAdapter<H>,
  fixture: Fixture,
  opts: { trials: number; opsPerTrial: number; seed: number },
): RandomResult {
  const rng = mulberry32(opts.seed)
  let passes = 0
  let firstFailure: RandomResult['firstFailure']
  for (let t = 0; t < opts.trials; t++) {
    const script = generateRandomScript(rng, fixture, opts.opsPerTrial)
    const { check } = runScript(adapter, fixture, script)
    if (check.pass) passes++
    else if (!firstFailure) firstFailure = { script, reason: check.reason }
  }
  return { passes, total: opts.trials, firstFailure }
}
