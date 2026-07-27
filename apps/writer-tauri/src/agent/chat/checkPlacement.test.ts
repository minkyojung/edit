// The check's job is to refuse proposals that cannot land. Its FIRST job is not
// to refuse the ones that can — and the ways it could get that wrong all look
// alike from inside: no handle, hydration that throws, a body that reads empty.
// Each of those means "we don't know", and "we don't know" must not become "no".
//
// Chat edits usually target notes that are not open, so the not-hydrated case is
// the common path, not an edge. A check that failed closed there would refuse
// most legitimate edits — strictly worse than the silent drop it replaces.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  handle: { contentReady: Promise.resolve() } as { contentReady: Promise<void> },
  handleExists: true,
  ensureThrows: false,
  body: '',
}))

vi.mock('@/state/docsStore', () => ({
  useDocsStore: {
    getState: () => ({
      ensureHandle: async () => {
        if (state.ensureThrows) throw new Error('hydration failed')
      },
      handles: state.handleExists ? { note: state.handle } : {},
    }),
  },
}))
vi.mock('@/state/docsStore/docBody', () => ({ readDocBody: () => state.body }))

import { checkEditPlacement, describeRefusal } from './checkPlacement'
import type { PendingChange, PendingEdit } from '@/state/pendingChangesStore'

function change(
  edits: Array<Pick<PendingEdit, 'kind' | 'before' | 'after'> & Partial<Pick<PendingEdit, 'anchorBefore'>>>,
): PendingChange {
  return {
    id: 'c1', source: 'chat', pageSlug: 'note', groupId: 'g1', createdAt: 0,
    edits: edits.map((e, i) => ({ id: `e${i}`, anchorBefore: '', ...e })),
    context: {}, status: 'pending', decidedAt: null, viewedAt: null,
    pageMarkdownSnapshot: '', feedbackDeliveredAt: null,
  } as unknown as PendingChange
}

const swap = change([{ kind: 'replace', before: '안녕하세요', after: '반갑습니다' }])

beforeEach(() => {
  state.handle = { contentReady: Promise.resolve() }
  state.handleExists = true
  state.ensureThrows = false
  state.body = '# Greeting\n\n안녕하세요\n'
})

describe('fail open — an unknown document is never a refusal', () => {
  it('passes when the note has no handle (never opened)', async () => {
    state.handleExists = false
    expect(await checkEditPlacement('note', swap, 'wiki/Greeting.md')).toEqual({ ok: true })
  })

  it('passes when hydration throws', async () => {
    state.ensureThrows = true
    expect(await checkEditPlacement('note', swap, 'wiki/Greeting.md')).toEqual({ ok: true })
  })

  it('passes when contentReady rejects', async () => {
    state.handle = { contentReady: Promise.reject(new Error('load failed')) }
    expect(await checkEditPlacement('note', swap, 'wiki/Greeting.md')).toEqual({ ok: true })
  })

  it('passes when the body reads empty', async () => {
    // Indistinguishable from a hydration that quietly produced nothing, so it
    // is not evidence that the anchor is missing.
    state.body = ''
    expect(await checkEditPlacement('note', swap, 'wiki/Greeting.md')).toEqual({ ok: true })
  })
})

describe('with a document in hand', () => {
  it('passes an edit whose anchor is present', async () => {
    expect(await checkEditPlacement('note', swap, 'wiki/Greeting.md')).toEqual({ ok: true })
  })

  it('passes an edit that has ALREADY been made', async () => {
    // The exact shape seen in the app: the model proposes a swap that is already
    // in the document. Refusing it starts a retry loop it cannot escape.
    state.body = '# Greeting\n\n반갑습니다\n'
    expect(await checkEditPlacement('note', swap, 'wiki/Greeting.md')).toEqual({ ok: true })
  })

  it('refuses an anchor that is not there, quoting the current content', async () => {
    // One jamo off — the drift that made a proposal vanish silently in the app.
    state.body = '# Greeting\n\n안녀앟\n'
    const r = await checkEditPlacement('note', swap, 'wiki/Greeting.md')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('not in wiki/Greeting.md')
    expect(r.reason).toContain('안녀앟') // the model can rebase without re-reading
  })

  it('refuses an ambiguous anchor with DIFFERENT advice', async () => {
    state.body = '안녕하세요\n안녕하세요\n'
    const r = await checkEditPlacement('note', swap, 'wiki/Greeting.md')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('more than one place')
    expect(r.reason).toContain('surrounding lines')
    // Telling an ambiguous anchor to "rebase onto the content below" would send
    // the model to re-read text it already matched — the advice must not collide.
    expect(r.reason).not.toContain('not in wiki/Greeting.md')
  })
})

describe('describeRefusal', () => {
  it('names the offending edit when there are several (MultiEdit)', () => {
    const reason = describeRefusal(
      { kind: 'absent', editIndex: 1, target: 'missing' },
      'wiki/Greeting.md', 'body', 3,
    )
    expect(reason.startsWith('(edit #2)')).toBe(true)
  })

  it('omits the index for a single edit', () => {
    const reason = describeRefusal(
      { kind: 'absent', editIndex: 0, target: 'missing' },
      'wiki/Greeting.md', 'body', 1,
    )
    expect(reason.startsWith('(edit #')).toBe(false)
  })

  it('truncates a large document rather than quoting all of it', () => {
    const huge = 'x'.repeat(9000)
    const reason = describeRefusal(
      { kind: 'absent', editIndex: 0, target: 'missing' },
      'wiki/Big.md', huge, 1,
    )
    expect(reason).toContain('truncated')
    expect(reason.length).toBeLessThan(huge.length)
  })
})
