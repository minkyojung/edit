/**
 * Stage 1 — no-edit roundtrip.
 *
 * Pass criteria (from the plan):
 *   - Every mark resolves with status === 'confident'
 *   - Resolved range covers exactly the same text as the original
 *
 * Failure of any single mark in this stage means Option B is not viable —
 * if marks can't even survive a serialize→deserialize with zero edits, no
 * amount of fuzzy matching will save them once external edits enter.
 */

import { describe, expect, it } from 'vitest'

import { deserialize } from '../deserializer.js'
import { serialize } from '../serializer.js'
import { basicParagraph } from '../fixtures/basic-paragraph.js'
import { multiMarkPage } from '../fixtures/multi-mark-page.js'

describe('Stage 1: lossless roundtrip (no edits between save and load)', () => {
  it('basicParagraph — every mark resolves confidently to the original span', () => {
    const { md, sidecar } = serialize(basicParagraph)
    const result = deserialize(md, sidecar)

    expect(result.plainText).toBe(basicParagraph.text)
    expect(result.marks).toHaveLength(basicParagraph.marks.length)

    for (const original of basicParagraph.marks) {
      const resolved = result.marks.find((m) => m.id === original.id)
      expect(resolved, `mark ${original.id} missing after roundtrip`).toBeDefined()
      expect(resolved!.status, `mark ${original.id} not confident`).toBe('confident')
      expect(resolved!.range).toEqual({ from: original.from, to: original.to })
      // Sanity: the resolved range should yield the same text we started with.
      const text = result.plainText.slice(resolved!.range!.from, resolved!.range!.to)
      expect(text).toBe(basicParagraph.text.slice(original.from, original.to))
    }
  })

  it('multiMarkPage — duplicate-quote marks disambiguate via context/occurrence', () => {
    const { md, sidecar } = serialize(multiMarkPage)
    const result = deserialize(md, sidecar)

    expect(result.plainText).toBe(multiMarkPage.text)
    expect(result.marks).toHaveLength(multiMarkPage.marks.length)

    for (const original of multiMarkPage.marks) {
      const resolved = result.marks.find((m) => m.id === original.id)
      expect(resolved, `mark ${original.id} missing after roundtrip`).toBeDefined()
      expect(resolved!.status, `mark ${original.id} not confident`).toBe('confident')
      expect(
        resolved!.range,
        `mark ${original.id} range mismatch: got ${JSON.stringify(resolved!.range)}, expected ${JSON.stringify({ from: original.from, to: original.to })}`,
      ).toEqual({ from: original.from, to: original.to })
    }
  })

  it('sidecar shape is JSON-serializable (we can write to disk)', () => {
    const { sidecar } = serialize(multiMarkPage)
    const json = JSON.stringify(sidecar)
    const parsed = JSON.parse(json) as typeof sidecar
    expect(parsed.version).toBe(1)
    expect(parsed.marks).toHaveLength(multiMarkPage.marks.length)
    for (const mark of parsed.marks) {
      expect(mark.anchor.quote).toBeTruthy()
      expect(typeof mark.anchor.occurrence).toBe('number')
    }
  })
})
