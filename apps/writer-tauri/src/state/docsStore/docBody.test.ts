import { beforeEach, describe, expect, it, vi } from 'vitest'

// Real runExclusive (keyedMutex) so the serialization test exercises the actual
// mutex; everything else is mocked to a controllable in-memory handle.
const state = vi.hoisted(() => ({
  handle: { bodyMarkdown: '', contentReady: Promise.resolve() } as {
    bodyMarkdown: string
    contentReady: Promise<void>
  },
  handleExists: true,
  livePull: null as string | null,
  conflict: false,
  markDirty: vi.fn(),
  clearDirty: vi.fn(),
  applyToEditor: vi.fn(() => false),
}))

vi.mock('@/state/docsStore', () => ({
  useDocsStore: {
    getState: () => ({
      ensureHandle: async () => {},
      handles: state.handleExists ? { note: state.handle } : {},
    }),
  },
}))
vi.mock('@/state/activeCmEditor', () => ({
  pullActiveCmBody: () => state.livePull,
  applyMarkdownToActiveCmEditor: (...args: unknown[]) =>
    state.applyToEditor(...(args as [])),
}))
vi.mock('@/state/externalConflictStore', () => ({
  hasExternalConflict: () => state.conflict,
}))
vi.mock('@/lib/docFileSync', () => ({
  markSlugDirty: (...a: unknown[]) => state.markDirty(...(a as [])),
  clearDirty: (...a: unknown[]) => state.clearDirty(...(a as [])),
}))

import { updateDocBody, readDocBody } from './docBody'

beforeEach(() => {
  state.handle.bodyMarkdown = ''
  state.handle.contentReady = Promise.resolve()
  state.handleExists = true
  state.livePull = null
  state.conflict = false
  state.markDirty.mockClear()
  state.clearDirty.mockClear()
  state.applyToEditor.mockClear()
})

describe('updateDocBody', () => {
  it('serializes concurrent writes on one slug — no lost update', async () => {
    // Both read-modify-writes append; with the per-slug mutex, call order is
    // preserved and both land ('AB'). Without it, both read '' and the last
    // write wins ('B') — the lost-update bug this funnel prevents.
    await Promise.all([
      updateDocBody('note', (c) => c + 'A'),
      updateDocBody('note', (c) => c + 'B'),
    ])
    expect(state.handle.bodyMarkdown).toBe('AB')
  })

  it('transforms the LIVE editor body when mounted, not the stale mirror', async () => {
    // The applyIngest regression guard: an accept computed against the mirror
    // would drop keystrokes typed since the last flush.
    state.handle.bodyMarkdown = 'STALE'
    state.livePull = 'live text'
    let seen = ''
    const r = await updateDocBody('note', (c) => {
      seen = c
      return c + '!'
    })
    expect(seen).toBe('live text')
    expect(state.handle.bodyMarkdown).toBe('live text!')
    expect(r).toEqual({ ok: true, changed: true })
  })

  it('refuses a whole-doc overwrite when the live body diverged from expectedBase (stale)', async () => {
    // The scenario: AI computed a whole-doc rewrite against a 3-line base;
    // the user typed a 4th line into the open editor meanwhile. The CAS
    // guard must refuse rather than clobber the user's line.
    const base = '# 회의록\n## 참석자\n- 민교'
    state.livePull = '# 회의록\n## 참석자\n- 민교\n- 윌리엄'
    const r = await updateDocBody('note', () => 'AI REWRITE', {
      expectedBase: base,
    })
    expect(r).toEqual({
      ok: false,
      reason: 'stale',
      stale: {
        base,
        latest: state.livePull,
        changedLines: [{ from: 4, to: 4 }],
      },
    })
    // Never touched the mirror or marked dirty — the user's edit survives.
    expect(state.handle.bodyMarkdown).toBe('')
    expect(state.markDirty).not.toHaveBeenCalled()
    expect(state.applyToEditor).not.toHaveBeenCalled()
  })

  it('applies a whole-doc overwrite when the live body still equals expectedBase', async () => {
    const base = 'line one\nline two'
    state.livePull = base
    const r = await updateDocBody('note', () => 'REWRITTEN', {
      expectedBase: base,
    })
    expect(r).toEqual({ ok: true, changed: true })
    expect(state.handle.bodyMarkdown).toBe('REWRITTEN')
    expect(state.markDirty).toHaveBeenCalledWith('note')
  })

  it('tolerates a trailing-newline-only difference against expectedBase', async () => {
    state.livePull = 'a\nb\n'
    const r = await updateDocBody('note', () => 'c', { expectedBase: 'a\nb' })
    expect(r).toEqual({ ok: true, changed: true })
    expect(state.handle.bodyMarkdown).toBe('c')
  })

  it('reports conflict without mutating the mirror', async () => {
    state.handle.bodyMarkdown = 'original'
    state.conflict = true
    const r = await updateDocBody('note', () => 'new')
    expect(r).toEqual({ ok: false, reason: 'conflict' })
    expect(state.handle.bodyMarkdown).toBe('original')
    expect(state.markDirty).not.toHaveBeenCalled()
  })

  it('external write bypasses the conflict gate and clears dirty', async () => {
    state.handle.bodyMarkdown = 'old'
    state.conflict = true
    const r = await updateDocBody('note', () => 'disk', {
      source: 'external',
      resolvesConflict: true,
    })
    expect(r).toEqual({ ok: true, changed: true })
    expect(state.handle.bodyMarkdown).toBe('disk')
    expect(state.clearDirty).toHaveBeenCalledWith('note')
    expect(state.markDirty).not.toHaveBeenCalled()
  })

  it('skips a no-op transform (no dirty mark)', async () => {
    state.handle.bodyMarkdown = 'same'
    const r = await updateDocBody('note', (c) => c)
    expect(r).toEqual({ ok: true, changed: false })
    expect(state.markDirty).not.toHaveBeenCalled()
    expect(state.applyToEditor).not.toHaveBeenCalled()
  })

  it('marks dirty and pushes to the editor on a local write', async () => {
    const r = await updateDocBody('note', () => 'body', {
      source: 'local',
      changeId: 'c1',
    })
    expect(r).toEqual({ ok: true, changed: true })
    expect(state.markDirty).toHaveBeenCalledWith('note')
    expect(state.applyToEditor).toHaveBeenCalledWith('note', 'body', 'c1')
  })

  it('returns no-handle when the doc has no handle', async () => {
    state.handleExists = false
    const r = await updateDocBody('note', () => 'x')
    expect(r).toEqual({ ok: false, reason: 'no-handle' })
  })

  it('returns hydrate-failed when contentReady rejects', async () => {
    state.handle.contentReady = Promise.reject(new Error('load failed'))
    const r = await updateDocBody('note', () => 'x')
    expect(r).toEqual({ ok: false, reason: 'hydrate-failed' })
  })
})

// The canonical read every consumer routes through (Phase 4: rich copy, chat
// @mentions, the applier's stale-anchor + reject-cleanup checks). The mirror is
// deliberately STALE while an editor is mounted (the flush no longer writes it
// back), so reading it directly would lag the live editor — these pin that
// readDocBody prefers the live body over the stale mirror.
describe('readDocBody', () => {
  it('returns the LIVE editor body when one is mounted, NOT the stale mirror', () => {
    state.handle.bodyMarkdown = 'STALE mirror' // last flush
    state.livePull = 'LIVE — just typed, not flushed' // mounted editor
    expect(readDocBody('note')).toBe('LIVE — just typed, not flushed')
  })

  it('falls back to the mirror when no editor is mounted', () => {
    state.handle.bodyMarkdown = 'mirror body'
    state.livePull = null // nothing mounted on this slug
    expect(readDocBody('note')).toBe('mirror body')
  })

  it('returns empty string when the doc has no handle', () => {
    state.handleExists = false
    state.livePull = null
    expect(readDocBody('note')).toBe('')
  })
})
