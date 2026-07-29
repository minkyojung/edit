// `set_note_status` / `set_note_tags` tell the model they worked before anyone
// has looked at the note. The store has four ways to decline and all four are a
// bare `return`, so "완료 처리했습니다" is what the user hears whether or not the
// status changed.
//
// These pin the outcome the setters report. Not the mutation — that already
// worked; what was missing is any way for a caller to find out it didn't
// happen. `setDocProperty` in this same file already returns a boolean, so the
// shape is the file's own precedent, widened from "did it" to "why not" because
// the model's next move differs: a note that cannot carry a status is a dead
// end, a note that is missing means re-read the vault, and an unchanged status
// is success.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/docFileSync', () => ({
  flushDirty: vi.fn(async () => {}),
  markSlugDirty: vi.fn(),
  markPropertiesDirty: vi.fn(),
  markDirty: vi.fn(),
  clearDirty: vi.fn(),
}))

import { useDocsStore } from '@/state/docsStore'
import type { KnownDoc } from '@/state/docsStore/types'

const doc = (slug: string, type: string, extra: Partial<KnownDoc> = {}): KnownDoc =>
  ({ slug, type, title: slug, ...extra }) as unknown as KnownDoc

beforeEach(() => {
  useDocsStore.setState({
    knownDocs: [
      doc('wiki/Alpha', 'wiki:custom-note', { status: 'not-started', tags: ['a'] }),
      doc('inbox/Loose', 'note', { relPath: 'inbox/Loose.md' }),
      doc('daily/2026-07-29', 'daily'),
      doc('system/Index', 'system:index'),
    ],
  } as never)
})

describe('setDocStatus reports what it did', () => {
  it('says so when the status actually changed', () => {
    const r = useDocsStore.getState().setDocStatus('wiki/Alpha', 'done')
    expect(r).toEqual({ ok: true })
    expect(useDocsStore.getState().knownDocs[0].status).toBe('done')
  })

  it('treats an already-correct status as success, not as a failure', () => {
    // The user asked for `done`; the note is `done`. Reporting a refusal here
    // would make the model retry or apologise for a state that is correct.
    useDocsStore.getState().setDocStatus('wiki/Alpha', 'done')
    expect(useDocsStore.getState().setDocStatus('wiki/Alpha', 'done')).toEqual({ ok: true })
  })

  it('names a note it cannot find rather than returning quietly', () => {
    const r = useDocsStore.getState().setDocStatus('wiki/Nope', 'done')
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ reason: 'no-such-note' })
  })

  it('names a daily journal as a doc type that has no status', () => {
    // The tool description already says the host ignores these. Until now the
    // model had no way to learn that it had just been ignored.
    const r = useDocsStore.getState().setDocStatus('daily/2026-07-29', 'done')
    expect(r).toEqual({ ok: false, reason: 'unsupported-doc-type' })
  })

  it('names a system page the same way', () => {
    expect(useDocsStore.getState().setDocStatus('system/Index', 'done')).toEqual({
      ok: false,
      reason: 'unsupported-doc-type',
    })
  })
})

describe('setDocTags reports what it did', () => {
  it('says so when the tags actually changed', () => {
    expect(useDocsStore.getState().setDocTags('wiki/Alpha', ['x', 'y'])).toEqual({ ok: true })
    expect(useDocsStore.getState().knownDocs[0].tags).toEqual(['x', 'y'])
  })

  it('treats an unchanged tag list as success', () => {
    expect(useDocsStore.getState().setDocTags('wiki/Alpha', ['a'])).toEqual({ ok: true })
  })

  it('reports a missing note and an unsupported type distinctly', () => {
    expect(useDocsStore.getState().setDocTags('wiki/Nope', ['x'])).toMatchObject({
      reason: 'no-such-note',
    })
    expect(useDocsStore.getState().setDocTags('daily/2026-07-29', ['x'])).toMatchObject({
      reason: 'unsupported-doc-type',
    })
  })
})

describe('moveDocToFolder reports what it did', () => {
  it('says so when the note actually moved', () => {
    expect(useDocsStore.getState().moveDocToFolder('inbox/Loose', 'people')).toEqual({ ok: true })
    const moved = useDocsStore.getState().knownDocs.find((d) => d.slug === 'inbox/Loose')
    expect(moved?.relPath).toBe('people/Loose.md')
  })

  it('treats a note already in that folder as success', () => {
    useDocsStore.getState().moveDocToFolder('inbox/Loose', 'people')
    expect(useDocsStore.getState().moveDocToFolder('inbox/Loose', 'people')).toEqual({ ok: true })
  })

  it('names a doc whose location is derived from its type', () => {
    // Only generic notes carry a free-form relPath. A wiki page's path comes
    // from its type, so this is a dead end and the model must be told so
    // rather than told the move applied.
    expect(useDocsStore.getState().moveDocToFolder('wiki/Alpha', 'people')).toEqual({
      ok: false,
      reason: 'unsupported-doc-type',
    })
    expect(useDocsStore.getState().moveDocToFolder('daily/2026-07-29', 'people')).toMatchObject({
      reason: 'unsupported-doc-type',
    })
  })

  it('names a note it cannot find', () => {
    expect(useDocsStore.getState().moveDocToFolder('nope', 'people')).toMatchObject({
      reason: 'no-such-note',
    })
  })
})
