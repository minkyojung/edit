// Characterization tests for the applier — the step that turns a user's Keep
// into a disk write.
//
// WHY THIS FILE EXISTS
// 436 lines with no test. It is also the exact component the auto-accept
// save-loss diagnosis named as the root: "manual Keep / new note / merge
// branches have write-ownership, but the applier's disk path alone is outside
// that discipline." Four defects were fixed around it; the applier's own
// routing — which edit kind goes to which writer, when a write is skipped, what
// happens when one fails — was never pinned.
//
// WHAT IS REAL AND WHAT IS MOCKED
// Real: the applier, the real pendingChangesStore, the real status lifecycle.
// Mocked: the three write helpers (so "disk" is an observable fake), the editor
// bridge, git, notify. Assertions are on WHICH writer was called with WHAT —
// that is the applier's whole job.
//
// MODULE STATE
// `startPendingChangesApplier` has no `stop`, and the module holds `handledIds`,
// the group timers and the subscription at module scope. So each test gets a
// fresh module via `vi.resetModules()` + dynamic import; without that, test 2
// inherits test 1's `handledIds` and silently skips its apply.
//
// HOW THESE WERE PROVEN TO BE ABLE TO FAIL
// Same discipline as editPending.characterization.test.ts: a characterization
// test passes on unchanged code by construction, so each block names the product
// mutation that must turn it red. All were applied and observed. See the header
// comment above each `it`.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { fake } = vi.hoisted(() => ({
  fake: {
    /** slug → body, standing in for disk. */
    bodies: {} as Record<string, string>,
    /** Every write the applier performed, in order. */
    writes: [] as { via: string; slug: string; arg: string; arg2?: string }[],
    /** Make the next write of this kind fail. */
    failKind: null as null | 'append' | 'replace' | 'write',
    /** What isChangeMaterializedInActiveCm answers. */
    materialized: false,
    commits: [] as string[],
    notified: [] as string[],
    trashed: [] as string[],
    knownDocs: [{ slug: 'note', title: 'Note' }] as { slug: string; title?: string }[],
    bootstrapping: false,
  },
}))

vi.mock('@/agent/applyIngest', () => ({
  appendMarkdownToWikiPage: vi.fn(async (slug: string, text: string) => {
    fake.writes.push({ via: 'append', slug, arg: text })
    if (fake.failKind === 'append') return false
    fake.bodies[slug] = (fake.bodies[slug] ?? '') + text
    return true
  }),
  applyReplaceInWikiPage: vi.fn(async (slug: string, before: string, after: string) => {
    fake.writes.push({ via: 'replace', slug, arg: before, arg2: after })
    if (fake.failKind === 'replace') return false
    fake.bodies[slug] = (fake.bodies[slug] ?? '').replace(before, after)
    return true
  }),
  applyWriteWikiPage: vi.fn(async (slug: string, content: string) => {
    fake.writes.push({ via: 'write', slug, arg: content })
    if (fake.failKind === 'write') return false
    fake.bodies[slug] = content
    return true
  }),
}))
vi.mock('@/state/activeCmEditor', () => ({
  isChangeMaterializedInActiveCm: () => fake.materialized,
}))
vi.mock('@/state/docsStore/docBody', () => ({
  readDocBody: (slug: string) => fake.bodies[slug] ?? '',
}))
vi.mock('@/state/docsStore', () => ({
  useDocsStore: {
    getState: () => ({
      knownDocs: fake.knownDocs,
      bootstrapping: fake.bootstrapping,
      deleteToTrash: async (slug: string) => {
        fake.trashed.push(slug)
        return true
      },
    }),
    subscribe: () => () => {},
  },
}))
vi.mock('@/state/gitStore', () => ({
  useGitStore: {
    getState: () => ({
      commitChangesNow: async (msg: string) => {
        fake.commits.push(msg)
      },
    }),
  },
  aiEditSubject: (type: string, names?: string[]) =>
    `${type}(ai): ${(names ?? []).join(', ')}`,
}))
vi.mock('@/lib/notify', () => ({
  notify: new Proxy({}, { get: (_t, p: string) => () => fake.notified.push(p) }),
}))

import type { PendingEdit } from './pendingChangesStore'
type Store = typeof import('./pendingChangesStore')['usePendingChangesStore']

/** The store the applier under test is actually subscribed to.
 *
 * `vi.resetModules()` re-evaluates the applier's whole import graph, including
 * pendingChangesStore — so a statically-imported store here would be a
 * DIFFERENT instance and the applier would never see the accept. (It doesn't
 * fail loudly: every test just records zero writes.) Both come out of the same
 * fresh graph instead. */
let usePendingChangesStore: Store

/** A fresh applier instance, subscribed. Module-level state (handledIds, group
 * timers) is reset with it — see the header. */
async function startFreshApplier() {
  vi.resetModules()
  usePendingChangesStore = (await import('./pendingChangesStore')).usePendingChangesStore
  usePendingChangesStore.setState({ byId: {} })
  const mod = await import('./pendingChangesApplier')
  mod.startPendingChangesApplier()
}

function stage(id: string, edits: PendingEdit[], extra: Record<string, unknown> = {}) {
  usePendingChangesStore.getState().push({
    id,
    source: 'chat',
    pageSlug: 'note',
    groupId: 'group-1',
    edits,
    context: { threadId: 'thread-1' },
    ...extra,
  } as Parameters<ReturnType<Store['getState']>['push']>[0])
}

const edit = (e: Partial<PendingEdit>): PendingEdit => ({
  id: 'e1',
  kind: 'replace',
  anchorBefore: '',
  ...e,
})

/** The applier's work is async under a zustand notification, so let the
 * microtask chain settle. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  fake.bodies = { note: '원래 본문\n' }
  fake.writes = []
  fake.failKind = null
  fake.materialized = false
  fake.commits = []
  fake.notified = []
  fake.trashed = []
  fake.knownDocs = [{ slug: 'note', title: 'Note' }]
  fake.bootstrapping = false
  // The store is reset inside startFreshApplier, once its instance exists.
})

afterEach(() => {
  vi.useRealTimers()
})

describe('applier: which writer each edit kind reaches', () => {
  // BREAKS IF: the `kind === 'add'` branch stops routing to
  // appendMarkdownToWikiPage (e.g. someone "simplifies" it to a whole-doc
  // write). An append that becomes an overwrite destroys the rest of the note.
  it("routes an 'add' to append, not to a whole-doc write", async () => {
    await startFreshApplier()
    stage('c1', [edit({ kind: 'add', after: '붙일 줄\n' })])
    usePendingChangesStore.getState().accept('c1')
    await settle()

    expect(fake.writes).toEqual([{ via: 'append', slug: 'note', arg: '붙일 줄\n' }])
    expect(fake.bodies.note).toBe('원래 본문\n붙일 줄\n')
  })

  // BREAKS IF: the `!edit.before` discriminator in the 'replace' branch is
  // dropped. A chat Write arrives as replace-with-no-before and MUST become a
  // wholesale write; sending it to the range replacer would replace '' — i.e.
  // insert at position 0 — and leave the old content behind.
  it("routes a 'replace' WITHOUT before to a whole-doc write", async () => {
    await startFreshApplier()
    stage('c1', [edit({ kind: 'replace', after: '통째로 새 본문\n' })])
    usePendingChangesStore.getState().accept('c1')
    await settle()

    expect(fake.writes).toEqual([{ via: 'write', slug: 'note', arg: '통째로 새 본문\n' }])
  })

  it("routes a 'replace' WITH before to the range replacer", async () => {
    await startFreshApplier()
    stage('c1', [edit({ kind: 'replace', before: '원래', after: '바뀐' })])
    usePendingChangesStore.getState().accept('c1')
    await settle()

    expect(fake.writes).toEqual([
      { via: 'replace', slug: 'note', arg: '원래', arg2: '바뀐' },
    ])
    expect(fake.bodies.note).toBe('바뀐 본문\n')
  })

  // BREAKS IF: delete stops passing '' as the replacement. Passing `after`
  // (undefined → 'undefined' once stringified) would write the literal word.
  it("routes a 'delete' to a replace with empty text", async () => {
    await startFreshApplier()
    stage('c1', [edit({ kind: 'delete', before: '원래 ' })])
    usePendingChangesStore.getState().accept('c1')
    await settle()

    expect(fake.writes).toEqual([{ via: 'replace', slug: 'note', arg: '원래 ', arg2: '' }])
    expect(fake.bodies.note).toBe('본문\n')
  })

  // BREAKS IF: the `resolvedResult` short-circuit is removed. That value is the
  // document the in-editor review already merged (user's own edits included);
  // re-deriving from `edits` would drop them.
  it('applies resolvedResult verbatim instead of re-deriving from edits', async () => {
    await startFreshApplier()
    stage('c1', [edit({ kind: 'replace', before: '원래', after: '무시될 값' })])
    usePendingChangesStore.getState().accept('c1', '사용자가 손본 최종 본문\n')
    await settle()

    expect(fake.writes).toEqual([
      { via: 'write', slug: 'note', arg: '사용자가 손본 최종 본문\n' },
    ])
  })
})

describe('applier: when it must NOT write', () => {
  // BREAKS IF: the isChangeMaterializedInActiveCm guard is removed. The
  // in-buffer review already put the text in the buffer and owns the save, so a
  // second apply here would re-place an anchor that no longer matches.
  it('defers entirely when the in-buffer review already materialized the change', async () => {
    fake.materialized = true
    await startFreshApplier()
    stage('c1', [edit({ kind: 'replace', before: '원래', after: '바뀐' })])
    usePendingChangesStore.getState().accept('c1')
    await settle()

    expect(fake.writes).toEqual([])
    expect(fake.bodies.note).toBe('원래 본문\n')
  })

  it('writes nothing on reject', async () => {
    await startFreshApplier()
    stage('c1', [edit({ kind: 'replace', before: '원래', after: '바뀐' })])
    usePendingChangesStore.getState().reject('c1')
    await settle()

    expect(fake.writes).toEqual([])
    expect(fake.bodies.note).toBe('원래 본문\n')
  })

  // BREAKS IF: the handledIds re-entrancy guard is removed. The applier's own
  // markApplyFailed / status reads re-notify the store, and every notification
  // re-scans every entry — without the mark, one Keep writes repeatedly.
  it('applies an accepted change exactly once despite repeated notifications', async () => {
    await startFreshApplier()
    stage('c1', [edit({ kind: 'add', after: '한 번만\n' })])
    usePendingChangesStore.getState().accept('c1')
    await settle()
    // Any unrelated store activity re-runs the subscriber over all entries.
    stage('c2', [edit({ kind: 'add', after: '다른 변경\n' })])
    await settle()

    expect(fake.writes.filter((w) => w.arg === '한 번만\n')).toHaveLength(1)
  })
})

describe('applier: an apply that could not be placed', () => {
  // BREAKS IF: the `!ok` branch stops calling markApplyFailed. The change stays
  // 'accepted' either way, so without this flag every surface reads "Kept" for
  // a write that never happened — and the model is never corrected, because the
  // edit-outcome note is built from exactly this flag.
  it('marks the change as failed and tells the user, without reopening it', async () => {
    fake.failKind = 'replace'
    await startFreshApplier()
    stage('c1', [edit({ kind: 'replace', before: '없는 텍스트', after: '무엇이든' })])
    usePendingChangesStore.getState().accept('c1')
    await settle()

    const c = usePendingChangesStore.getState().byId.c1
    expect(c.status).toBe('accepted') // dismissed, NOT reopened — Cursor's rule
    expect(c.applyFailed).toBe(true)
    expect(fake.notified).toContain('markCantApply')
  })
})

describe('applier: group commit', () => {
  // BREAKS IF: the debounce collapses to one commit per Keep, or the group key
  // stops being groupId. History is meant to read one run = one commit.
  it('lands a burst of Keeps as a single commit after the quiet window', async () => {
    vi.useFakeTimers()
    await startFreshApplier()
    stage('c1', [edit({ id: 'e1', kind: 'add', after: 'A\n' })])
    stage('c2', [edit({ id: 'e2', kind: 'add', after: 'B\n' })])
    usePendingChangesStore.getState().accept('c1')
    usePendingChangesStore.getState().accept('c2')
    await vi.advanceTimersByTimeAsync(0)

    expect(fake.commits).toHaveLength(0) // still inside the quiet window
    await vi.advanceTimersByTimeAsync(1600)

    expect(fake.commits).toHaveLength(1)
    expect(fake.commits[0]).toContain('edit(ai)')
  })

  // BREAKS IF: a failed apply starts being added to the accepts list. Committing
  // a burst in which nothing reached disk produces an empty `edit(ai)` commit,
  // which the undo skill would then offer to revert.
  it('does not commit a burst in which every apply failed', async () => {
    vi.useFakeTimers()
    fake.failKind = 'append'
    await startFreshApplier()
    stage('c1', [edit({ kind: 'add', after: 'A\n' })])
    usePendingChangesStore.getState().accept('c1')
    await vi.advanceTimersByTimeAsync(1600)

    expect(fake.commits).toEqual([])
  })
})

describe('applier: a rejected new note', () => {
  // BREAKS IF: cleanupRejectedNewNote stops running on reject. A declined
  // "create this note" proposal would leave an empty file in the sidebar.
  it('trashes the empty note a rejected proposal had created', async () => {
    fake.bodies.note = '' // never populated — the proposal was declined
    await startFreshApplier()
    stage('c1', [edit({ kind: 'replace', after: '본문' })], { createdNewNote: true })
    usePendingChangesStore.getState().reject('c1')
    await settle()

    expect(fake.trashed).toEqual(['note'])
  })

  // BREAKS IF: the readDocBody guard is removed. The note is created empty and
  // the user may start typing in it before deciding — trashing it then destroys
  // their work, and it is THEIR text, not the model's.
  it('keeps the note when the user has typed into it', async () => {
    fake.bodies.note = '사용자가 직접 쓴 내용\n'
    await startFreshApplier()
    stage('c1', [edit({ kind: 'replace', after: '본문' })], { createdNewNote: true })
    usePendingChangesStore.getState().reject('c1')
    await settle()

    expect(fake.trashed).toEqual([])
  })

  // BREAKS IF: the "still targeted" guard is removed. Another live proposal for
  // the same note would lose the file out from under it.
  it('keeps the note when another undecided change still targets it', async () => {
    fake.bodies.note = ''
    await startFreshApplier()
    stage('c1', [edit({ kind: 'replace', after: '본문' })], { createdNewNote: true })
    stage('c2', [edit({ id: 'e2', kind: 'add', after: '다른 제안' })])
    usePendingChangesStore.getState().reject('c1')
    await settle()

    expect(fake.trashed).toEqual([])
  })
})
