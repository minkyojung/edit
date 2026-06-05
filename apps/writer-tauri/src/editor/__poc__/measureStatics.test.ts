// Static-metrics sibling deliverable (Phase 0). A CHECKED-IN, runnable
// measurement of the "(A) anchor / mapping / materialisation" layer — the
// code a CodeMirror move is hypothesised to shrink. Snapshotted so drift
// is visible in PRs, and computed identically (same proxy) for the CM
// side later so the comparison is fair.
//
// Metrics per file:
//   - rawLoc:       total lines
//   - effectiveLoc: non-blank, non-comment-only lines
//   - branches:     proxy decision-point count (if/else/case/?:/&&/||/
//                   return/catch) — a relative proxy, not a true CC.

import { describe, expect, it } from 'vitest'
// Vite `?raw` imports the file contents as a string — no node:fs needed,
// and typed via vite/client. The bundler inlines the current source, so
// the snapshot always reflects the checked-in (A)-layer code.
import anchorSearchSrc from '../anchorSearch.ts?raw'
import markReconcileSrc from '../markReconcile.ts?raw'
import markStampSrc from '../markStamp.ts?raw'
import inlineReviewPluginSrc from '../inlineReviewPlugin.ts?raw'
import pendingTargetsSrc from '../pendingTargets.ts?raw'
import cmAnchorSrc from './adapters/cmAnchor.ts?raw'

// The (A)-layer files.
const A_LAYER: Array<[string, string]> = [
  ['anchorSearch.ts', anchorSearchSrc],
  ['markReconcile.ts', markReconcileSrc],
  ['markStamp.ts', markStampSrc],
  ['inlineReviewPlugin.ts', inlineReviewPluginSrc],
  ['pendingTargets.ts', pendingTargetsSrc],
]

function isCommentOnly(line: string): boolean {
  const t = line.trim()
  return (
    t.startsWith('//') ||
    t.startsWith('/*') ||
    t.startsWith('*') ||
    t.startsWith('*/')
  )
}

function effectiveLoc(src: string): number {
  return src.split('\n').filter((l) => l.trim() !== '' && !isCommentOnly(l)).length
}

// Branch proxy: count decision points. Applied identically to PM and CM.
const BRANCH_PATTERNS: Array<[string, RegExp]> = [
  ['if', /\bif\b/g],
  ['else', /\belse\b/g],
  ['case', /\bcase\b/g],
  ['ternary', /\?(?!\.)/g], // `?` excluding optional-chaining `?.`
  ['and', /&&/g],
  ['or', /\|\|/g],
  ['return', /\breturn\b/g],
  ['catch', /\bcatch\b/g],
]

function branchCount(src: string): number {
  return BRANCH_PATTERNS.reduce((sum, [, re]) => sum + (src.match(re)?.length ?? 0), 0)
}

interface Metrics {
  rawLoc: number
  effectiveLoc: number
  branches: number
}

function metrics(src: string): Metrics {
  return {
    rawLoc: src.split('\n').length,
    effectiveLoc: effectiveLoc(src),
    branches: branchCount(src),
  }
}

function sum(ms: Metrics[]): Metrics {
  return ms.reduce(
    (a, m) => ({
      rawLoc: a.rawLoc + m.rawLoc,
      effectiveLoc: a.effectiveLoc + m.effectiveLoc,
      branches: a.branches + m.branches,
    }),
    { rawLoc: 0, effectiveLoc: 0, branches: 0 },
  )
}

describe('static metrics — (A) anchor/mapping/materialisation layer', () => {
  const perFile = A_LAYER.map(([file, src]) => ({ file, ...metrics(src) }))
  const total = sum(perFile)

  it('snapshot of per-file + total metrics (PM control)', () => {
    console.log(
      '\n[static metrics — PM (A) layer]\n' +
        '  file                    raw   eff  branch\n' +
        perFile
          .map(
            (f) =>
              `  ${f.file.padEnd(22)} ${String(f.rawLoc).padStart(4)} ${String(
                f.effectiveLoc,
              ).padStart(5)} ${String(f.branches).padStart(6)}`,
          )
          .join('\n') +
        `\n  ${'TOTAL'.padEnd(22)} ${String(total.rawLoc).padStart(4)} ${String(
          total.effectiveLoc,
        ).padStart(5)} ${String(total.branches).padStart(6)}\n`,
    )
    expect({ perFile, total }).toMatchSnapshot()
  })
})

// Head-to-head: the PM anchor logic CM REPLACES vs the CM layer.
//
// Fairness: we compare the four PM files that are PURELY anchor / resolve
// / materialise / target-adapter logic (anchorSearch + markReconcile +
// markStamp + pendingTargets) against cmAnchor.ts. inlineReviewPlugin is
// EXCLUDED from the head-to-head because it mixes the resolve/map core
// (which CM also has, ~the StateField) with widget-DOM rendering (the "(B)"
// layer that is common to both editors and not part of this comparison).
describe('PM vs CM — anchor logic head-to-head', () => {
  const PM_REPLACED = ['anchorSearch.ts', 'markReconcile.ts', 'markStamp.ts', 'pendingTargets.ts']
  const pmReplaced = sum(
    A_LAYER.filter(([f]) => PM_REPLACED.includes(f)).map(([, src]) => metrics(src)),
  )
  const cm = metrics(cmAnchorSrc)

  it('snapshot + ratio', () => {
    const ratio = (a: number, b: number) => (b === 0 ? '—' : `${(a / b).toFixed(1)}×`)
    console.log(
      '\n[PM vs CM — anchor logic]\n' +
        '  side                                 raw   eff  branch\n' +
        `  PM (anchorSearch+reconcile+stamp+    ${String(pmReplaced.rawLoc).padStart(4)} ${String(
          pmReplaced.effectiveLoc,
        ).padStart(5)} ${String(pmReplaced.branches).padStart(6)}\n` +
        '     pendingTargets)\n' +
        `  CM (cmAnchor.ts)                     ${String(cm.rawLoc).padStart(4)} ${String(
          cm.effectiveLoc,
        ).padStart(5)} ${String(cm.branches).padStart(6)}\n` +
        `  reduction                            ${ratio(pmReplaced.rawLoc, cm.rawLoc)} ${ratio(
          pmReplaced.effectiveLoc,
          cm.effectiveLoc,
        )}  ${ratio(pmReplaced.branches, cm.branches)}\n` +
        '  (inlineReviewPlugin excluded: mixes resolve/map core + widget DOM, (B) layer common to both)\n',
    )
    expect({ pmReplaced, cm }).toMatchSnapshot()
  })
})
