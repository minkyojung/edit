/**
 * markStoreImpl smoke tests.
 *
 * Scoped to behaviors that don't require a real ProseMirror EditorView
 * mounted in a DOM:
 *   - Argument validation (returns `invalid_args` / `noop` paths)
 *   - Handle-missing fallback (returns `view_not_ready`)
 *   - list / get / subscribe against a fixture Y.Map
 *
 * The PM-mutating paths (`add` happy path, `accept` body mutation,
 * `reject` removing the inline mark) require a real EditorView with
 * a Yjs binding and the proof schema. Those land in Phase 2's
 * verification when the markStore wires into actual call sites and
 * runs against the live editor — see Phase 1 doc, "Sandbox" section.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createMarkStore, type MarkStoreHandle } from './markStoreImpl'
import type { Mark } from './marks'

/** Build a markStore with a fixture handle. The handle's `view` is
 * a stub — only the `state.doc.descendants` shape is touched here,
 * which the tests below avoid by exercising non-PM-mutating paths. */
function makeStore(opts: {
  ydoc?: Y.Doc
  hasView?: boolean
} = {}) {
  const ydoc = opts.ydoc ?? new Y.Doc()
  const view = opts.hasView === false ? null : ({} as MarkStoreHandle['view'])

  const store = createMarkStore({
    getHandle: (slug) => {
      if (slug !== 'test') return null
      if (!view) return null
      return { view, ydoc }
    },
  })
  return { store, ydoc }
}

function seedMark(ydoc: Y.Doc, overrides: Partial<Mark> = {}): Mark {
  const mark: Mark = {
    id: overrides.id ?? 'm1',
    kind: 'suggestion',
    suggestionType: 'replace',
    quote: 'hello',
    startRel: 'AQ==',
    endRel: 'Ag==',
    content: 'goodbye',
    status: 'pending',
    by: 'ai:test',
    createdAt: '2026-05-15T17:00:00Z',
    ...overrides,
  }
  ydoc.getMap<Mark>('marks').set(mark.id, mark)
  return mark
}

describe('markStore.add — argument validation', () => {
  it('rejects empty slug as invalid_args', async () => {
    const { store } = makeStore()
    const result = await store.add({
      slug: '',
      kind: 'suggestion',
      suggestionType: 'replace',
      quote: 'hello',
      content: 'goodbye',
      by: 'ai:test',
    })
    expect(result).toEqual({ ok: false, reason: 'invalid_args' })
  })

  it('rejects empty quote', async () => {
    const { store } = makeStore()
    const result = await store.add({
      slug: 'test',
      kind: 'suggestion',
      suggestionType: 'replace',
      quote: '',
      content: 'goodbye',
      by: 'ai:test',
    })
    expect(result).toEqual({ ok: false, reason: 'invalid_args' })
  })

  it('rejects empty by', async () => {
    const { store } = makeStore()
    const result = await store.add({
      slug: 'test',
      kind: 'suggestion',
      suggestionType: 'replace',
      quote: 'hello',
      content: 'goodbye',
      by: '',
    })
    expect(result).toEqual({ ok: false, reason: 'invalid_args' })
  })

  it('rejects suggestion without suggestionType', async () => {
    const { store } = makeStore()
    const result = await store.add({
      slug: 'test',
      kind: 'suggestion',
      quote: 'hello',
      content: 'goodbye',
      by: 'ai:test',
    })
    expect(result).toEqual({ ok: false, reason: 'invalid_args' })
  })

  it('rejects insert/replace without content', async () => {
    const { store } = makeStore()
    const insert = await store.add({
      slug: 'test',
      kind: 'suggestion',
      suggestionType: 'insert',
      quote: 'hello',
      by: 'ai:test',
    })
    expect(insert).toEqual({ ok: false, reason: 'invalid_args' })

    const replace = await store.add({
      slug: 'test',
      kind: 'suggestion',
      suggestionType: 'replace',
      quote: 'hello',
      content: '',
      by: 'ai:test',
    })
    expect(replace).toEqual({ ok: false, reason: 'invalid_args' })
  })

  it('rejects replace where content equals quote as noop', async () => {
    const { store } = makeStore()
    const result = await store.add({
      slug: 'test',
      kind: 'suggestion',
      suggestionType: 'replace',
      quote: 'hello',
      content: 'hello',
      by: 'ai:test',
    })
    expect(result).toEqual({ ok: false, reason: 'noop' })
  })

  it('rejects comment without text', async () => {
    const { store } = makeStore()
    const result = await store.add({
      slug: 'test',
      kind: 'comment',
      quote: 'hello',
      by: 'ai:test',
    })
    expect(result).toEqual({ ok: false, reason: 'invalid_args' })
  })

  it('returns view_not_ready when handle is missing', async () => {
    const { store } = makeStore({ hasView: false })
    const result = await store.add({
      slug: 'test',
      kind: 'comment',
      quote: 'hello',
      text: 'note',
      by: 'ai:test',
    })
    expect(result).toEqual({ ok: false, reason: 'view_not_ready' })
  })

  it('returns view_not_ready for an unknown slug', async () => {
    const { store } = makeStore()
    const result = await store.add({
      slug: 'unknown',
      kind: 'comment',
      quote: 'hello',
      text: 'note',
      by: 'ai:test',
    })
    expect(result).toEqual({ ok: false, reason: 'view_not_ready' })
  })
})

describe('markStore.get', () => {
  it('returns null for unknown slug', () => {
    const { store } = makeStore()
    expect(store.get('unknown', 'm1')).toBeNull()
  })

  it('returns null when the mark id is not in the map', () => {
    const { store } = makeStore()
    expect(store.get('test', 'nonexistent')).toBeNull()
  })

  it('returns the stored mark', () => {
    const { store, ydoc } = makeStore()
    const mark = seedMark(ydoc, {
      kind: 'comment',
      suggestionType: undefined,
      content: undefined,
      text: 'note',
    })
    expect(store.get('test', mark.id)).toEqual(mark)
  })

  it('returns null for malformed entries (isValidMark fails)', () => {
    const { store, ydoc } = makeStore()
    ydoc.getMap<Mark>('marks').set('broken', { id: 'broken' } as Mark)
    expect(store.get('test', 'broken')).toBeNull()
  })
})

describe('markStore.list', () => {
  it('returns an empty list when no marks', () => {
    const { store } = makeStore()
    expect(store.list('test')).toEqual([])
  })

  it('skips malformed entries', () => {
    const { store, ydoc } = makeStore()
    // Use a comment mark — suggestion marks would trip refreshDriftStatus
    // which requires a real PM view (covered in Phase 2 verification).
    seedMark(ydoc, {
      id: 'good',
      kind: 'comment',
      suggestionType: undefined,
      content: undefined,
      text: 'note',
    })
    ydoc.getMap<Mark>('marks').set('broken', { id: 'broken' } as Mark)
    const result = store.list('test')
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('good')
  })

  it('filters by status', () => {
    const { store, ydoc } = makeStore()
    // Use comment marks here so the read path doesn't try to
    // refresh drift status (which would require a real PM view).
    seedMark(ydoc, {
      id: 'a',
      kind: 'comment',
      suggestionType: undefined,
      content: undefined,
      text: 'note a',
      status: 'pending',
    })
    seedMark(ydoc, {
      id: 'b',
      kind: 'comment',
      suggestionType: undefined,
      content: undefined,
      text: 'note b',
      status: 'accepted',
    })

    expect(store.list('test', { status: 'pending' }).map((m) => m.id)).toEqual(['a'])
    expect(store.list('test', { status: 'accepted' }).map((m) => m.id)).toEqual(['b'])
    expect(store.list('test').map((m) => m.id).sort()).toEqual(['a', 'b'])
  })
})

describe('markStore.subscribe', () => {
  it('fires immediately with the current state', () => {
    const { store, ydoc } = makeStore()
    seedMark(ydoc, {
      id: 'init',
      kind: 'comment',
      suggestionType: undefined,
      content: undefined,
      text: 'note',
    })

    let received: Mark[] | null = null
    const unsubscribe = store.subscribe('test', (marks) => {
      received = marks
    })
    expect(received).not.toBeNull()
    expect(received).toHaveLength(1)
    expect(received![0]?.id).toBe('init')
    unsubscribe()
  })

  it('fires on mark map mutation', () => {
    const { store, ydoc } = makeStore()
    const events: Mark[][] = []
    const unsubscribe = store.subscribe('test', (marks) => events.push(marks))

    ydoc.transact(() => {
      seedMark(ydoc, {
        id: 'a',
        kind: 'comment',
        suggestionType: undefined,
        content: undefined,
        text: 'note a',
      })
    })

    // Two events: initial empty, then post-insert.
    expect(events.length).toBeGreaterThanOrEqual(2)
    expect(events.at(-1)?.map((m) => m.id)).toEqual(['a'])
    unsubscribe()
  })

  it('stops firing after unsubscribe', () => {
    const { store, ydoc } = makeStore()
    const events: Mark[][] = []
    const unsubscribe = store.subscribe('test', (marks) => events.push(marks))
    const initialCount = events.length

    unsubscribe()

    ydoc.transact(() => {
      seedMark(ydoc, {
        id: 'a',
        kind: 'comment',
        suggestionType: undefined,
        content: undefined,
        text: 'note',
      })
    })

    expect(events.length).toBe(initialCount)
  })
})
