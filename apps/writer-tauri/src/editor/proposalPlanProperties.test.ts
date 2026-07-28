// Property tests over generated layouts.
//
// The example tests next door pin specific shapes; these assert that the CONTRACT
// holds for arbitrary ones. Both bugs that made a proposal eat its neighbour needed a
// particular arrangement — a green landing exactly where the next red begins — which
// no hand-written example happened to cover. Generating layouts finds that class
// without anyone having to imagine it first.
//
// The oracle is `checkMatInvariants`, the same predicate the dev-mode watchdog runs at
// runtime. Planning and watching therefore agree by construction: a layout the planner
// could produce but the watchdog would reject fails here, at build time.

import { describe, expect, it } from 'vitest'
import { planAdditional, greenRangesOf, stripRanges } from './proposalPlan'
import { checkMatInvariants } from './cmInBufferReview'
import type { PendingChange } from '@/state/pendingChangesStore'

function replaceChange(id: string, before: string, after: string): PendingChange {
  return {
    id,
    source: 'chat',
    pageSlug: 'note',
    groupId: 'g',
    createdAt: 0,
    edits: [{ id: `${id}:0`, kind: 'replace', anchorBefore: '', before, after }],
    context: {},
    status: 'pending',
  } as unknown as PendingChange
}

function applyInsertions(doc: string, insertions: { from: number; insert: string }[]): string {
  let text = doc
  for (const ins of [...insertions].sort((a, b) => b.from - a.from)) {
    text = text.slice(0, ins.from) + ins.insert + text.slice(ins.from)
  }
  return text
}

/** Deterministic, so a failure reproduces from the reported seed. */
function rng(seed: number) {
  let s = seed
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296)
}

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']

describe('planAdditional — properties over generated layouts', () => {
  it('holds the save contract and the watchdog invariants for 200 layouts', () => {
    const rand = rng(20260727)
    const failures: string[] = []

    for (let trial = 0; trial < 200; trial++) {
      // Distinct lines: a repeated line makes the edit's `before` ambiguous, which
      // `looseReplace` refuses by design. That is its own behaviour, not this contract.
      const lineCount = 2 + Math.floor(rand() * 4)
      const lines = Array.from({ length: lineCount }, (_, i) => `${WORDS[Math.floor(rand() * WORDS.length)]}${i}`)
      const clean = lines.join('\n')

      // Edit a distinct subset of lines — adjacent picks are what create the
      // green-meets-next-red boundary.
      const targets = [
        ...new Set(Array.from({ length: 1 + Math.floor(rand() * 3) }, () => Math.floor(rand() * lineCount))),
      ]
      const changes = targets.map((i, k) => replaceChange(`c${k}`, lines[i], lines[i].toUpperCase()))

      // Half the trials plan on top of an already-materialized proposal, which is the
      // arrangement that produced the swallowed-suggestion bug.
      const staged = rand() < 0.5 && targets.length > 1
      let realDoc = clean
      let greens: { from: number; to: number }[] = []
      if (staged) {
        const first = planAdditional(clean, [], [changes[0]])
        realDoc = applyInsertions(clean, first.insertions)
        greens = greenRangesOf(first.mats)
      }

      const plan = planAdditional(realDoc, greens, staged ? changes.slice(1) : changes)
      const result = applyInsertions(realDoc, plan.insertions)
      const at = `trial ${trial} doc=${JSON.stringify(clean)} staged=${staged}`

      // 1. The stated contract, for THIS plan: applying its insertions and then
      //    removing its greens returns the document it planned against. Compared
      //    against `realDoc` rather than `clean` on purpose — the earlier proposal's
      //    green ranges are in pre-insertion coordinates here, and mixing coordinate
      //    spaces is a bug in the test, not the planner (production hands over the
      //    ranges matField has already remapped).
      const savedWouldBe = stripRanges(result, greenRangesOf(plan.mats))
      if (savedWouldBe !== realDoc) {
        failures.push(`${at}: saved ${JSON.stringify(savedWouldBe)} != ${JSON.stringify(realDoc)}`)
      }

      // 2. Everything the runtime watchdog would reject.
      const violations = checkMatInvariants(plan.mats, result.length)
      if (violations.length) failures.push(`${at}: ${violations.map((v) => v.kind).join(',')}`)

      // 3. Each range points at the text it claims. The generator makes originals
      //    lowercase and proposals uppercase, so this reads directly: green must be a
      //    proposal, and red must be an ORIGINAL — never another proposal's
      //    suggestion. The red half is the one that matters: it is what accepting
      //    deletes, and covering a neighbour's green is how one proposal ate another.
      //    Stated in text rather than offsets so it stays coordinate-space-safe.
      for (const m of plan.mats) {
        for (const h of m.hunks) {
          const green = result.slice(h.greenFrom, h.greenTo).trim()
          if (green && !/^[A-Z]+[0-9]*$/.test(green)) {
            failures.push(`${at}: ${m.changeId} green=${JSON.stringify(green)} is not a proposal`)
          }
          const red = result.slice(h.redFrom, h.redTo).trim()
          if (red && /[A-Z]/.test(red)) {
            failures.push(`${at}: ${m.changeId} red=${JSON.stringify(red)} covers a proposal`)
          }
        }
      }
    }

    expect(failures.slice(0, 6)).toEqual([])
  })
})
