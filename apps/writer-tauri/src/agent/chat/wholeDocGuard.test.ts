import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateDocBodyResult } from '@/state/docsStore/docBody'

// Mock only the CAS write; the base tracking + reason builder are real (pure).
const checked =
  vi.fn<
    (
      slug: string,
      content: string,
      base: string | undefined,
      changeId?: string,
    ) => Promise<UpdateDocBodyResult>
  >()
vi.mock('@/agent/applyIngest', () => ({
  applyWriteWikiPageChecked: (
    ...a: [string, string, string | undefined, string?]
  ) => checked(...a),
}))

import { guardedWholeDocWrite } from './wholeDocGuard'
import {
  __resetModelBaseForTests,
  getModelBase,
  setModelBase,
  MAX_STALE_RETRIES,
} from '@/agent/modelBodyBase'

beforeEach(() => {
  __resetModelBaseForTests()
  checked.mockReset()
})

describe('guardedWholeDocWrite', () => {
  it('applies and advances the base when the write lands', async () => {
    checked.mockResolvedValue({ ok: true, changed: true })
    const out = await guardedWholeDocWrite('t1', 'note', 'NEW BODY', 'c1', 'wiki/Note.md')
    expect(out).toEqual({ kind: 'applied' })
    // Base advances to what the model just wrote, so its OWN follow-up write
    // this turn won't read as a divergence.
    expect(getModelBase('t1', 'note')).toBe('NEW BODY')
  })

  it('compares against the base the model was shown (false-positive guard)', async () => {
    setModelBase('t1', 'note', 'SHOWN BODY')
    checked.mockResolvedValue({ ok: true, changed: true })
    await guardedWholeDocWrite('t1', 'note', 'NEW', 'c1', 'wiki/Note.md')
    // CAS ran against what the model saw — not a blank — so an unchanged note
    // (live === shown) applies rather than false-flagging.
    expect(checked).toHaveBeenCalledWith('note', 'NEW', 'SHOWN BODY', 'c1')
  })

  it('refuses as stale and builds a rebase reason with the latest body inline', async () => {
    checked.mockResolvedValue({
      ok: false,
      reason: 'stale',
      stale: {
        base: 'a\nb',
        latest: 'a\nb\n- the user line',
        changedLines: [{ from: 3, to: 3 }],
      },
    })
    const out = await guardedWholeDocWrite('t1', 'note', 'MODEL BODY', 'c1', 'wiki/Note.md')
    expect(out.kind).toBe('stale')
    if (out.kind === 'stale') {
      expect(out.ackReason).toContain('wiki/Note.md')
      expect(out.ackReason).toContain('- the user line') // latest inline
      expect(out.ackReason).toContain('3') // changed line hint
    }
    // The base advances to the LATEST body (not the rejected write) — this is
    // exactly what the model is told to rebase against, so the resubmit's CAS
    // compares the live body to `latest` and can actually land.
    expect(getModelBase('t1', 'note')).toBe('a\nb\n- the user line')
  })

  it('lets the rebased resubmit land — base advanced to latest, no re-stale loop', async () => {
    // The model was shown B0; the user edited it to B1 while it generated.
    setModelBase('t1', 'note', 'B0')
    // First write: live body (B1) diverged from B0 → stale, latest is B1.
    checked.mockResolvedValueOnce({
      ok: false,
      reason: 'stale',
      stale: { base: 'B0', latest: 'B1', changedLines: [{ from: 1, to: 1 }] },
    })
    const first = await guardedWholeDocWrite('t1', 'note', 'MODEL v1', 'c1', 'f.md')
    expect(first.kind).toBe('stale')

    // The model rebases onto B1 and resubmits. The CAS now runs against B1 (the
    // advanced base) — matching the live body — so it applies instead of
    // re-staling forever.
    checked.mockResolvedValueOnce({ ok: true, changed: true })
    const second = await guardedWholeDocWrite('t1', 'note', 'MODEL v2', 'c1', 'f.md')
    expect(second.kind).toBe('applied')
    expect(checked).toHaveBeenLastCalledWith('note', 'MODEL v2', 'B1', 'c1')
  })

  it('parks after the retry cap instead of looping against a user who keeps typing', async () => {
    checked.mockResolvedValue({
      ok: false,
      reason: 'stale',
      stale: { base: 'x', latest: 'y', changedLines: [{ from: 1, to: 1 }] },
    })
    for (let i = 0; i < MAX_STALE_RETRIES; i++) {
      const out = await guardedWholeDocWrite('t1', 'note', 'b', 'c', 'f.md')
      expect(out.kind).toBe('stale')
    }
    const out = await guardedWholeDocWrite('t1', 'note', 'b', 'c', 'f.md')
    expect(out.kind).toBe('parked')
  })

  it('reports a hard failure as failed', async () => {
    checked.mockResolvedValue({ ok: false, reason: 'no-handle' })
    const out = await guardedWholeDocWrite('t1', 'note', 'b', 'c', 'f.md')
    expect(out.kind).toBe('failed')
  })
})

// Two conversations editing one note is the case the CAS exists for, and the
// case a slug-only key silently disables.
describe('guardedWholeDocWrite across conversations', () => {
  it("a landed write does not become another conversation's baseline", async () => {
    // Both were shown the same note, so both hold the same base — but they are
    // their own claims, and t2's write must not answer for t1's.
    setModelBase('t1', 'note', 'SHARED V0')
    setModelBase('t2', 'note', 'SHARED V0')

    checked.mockResolvedValue({ ok: true, changed: true })
    await guardedWholeDocWrite('t2', 'note', 'T2 WROTE THIS', 'c1', 'f.md')
    await guardedWholeDocWrite('t1', 'note', 'T1 WROTE THIS', 'c2', 'f.md')

    // t1 must still be judged against what t1 actually saw. Judged against t2's
    // result instead, the live body matches, the CAS waves it through, and t2's
    // work is overwritten with no error anywhere.
    expect(checked).toHaveBeenLastCalledWith('note', 'T1 WROTE THIS', 'SHARED V0', 'c2')
  })

  it("a conversation's stale bounces do not spend another's retry budget", async () => {
    checked.mockResolvedValue({
      ok: false,
      reason: 'stale',
      stale: { base: 'x', latest: 'y', changedLines: [{ from: 1, to: 1 }] },
    })
    for (let i = 0; i <= MAX_STALE_RETRIES; i++) {
      await guardedWholeDocWrite('t1', 'note', 'b', 'c', 'f.md')
    }

    // t2 has not bounced once, so it gets a rebase — not the exhausted-budget
    // park, which surfaces as "Couldn't save the AI's change / the file may be
    // locked", a diagnosis that has nothing to do with what happened.
    const out = await guardedWholeDocWrite('t2', 'note', 'b', 'c', 'f.md')
    expect(out.kind).toBe('stale')
  })
})
