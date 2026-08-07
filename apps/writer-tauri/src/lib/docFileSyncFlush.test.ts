// Characterization tests for `flushDirtyOnce` — the loop that turns a dirty
// slug into bytes on disk.
//
// WHY THIS FILE EXISTS
// docFileSync.ts is 808 lines and had 61 lines of test, covering two pure
// helpers (`shouldDeferStaleWrite`, the dirty-generation guard). The write loop
// itself — 230 lines, the last hop before the filesystem — had none. Every
// branch in it decides between "write", "skip and stay dirty" and "give up and
// clear dirty", and the difference between the last two is the difference
// between a retry and a silently dropped edit.
//
// WHAT IS REAL AND WHAT IS MOCKED
// Real: the flush loop, the dirty set, `lastWrittenPath`, and the path /
// frontmatter helpers it composes with. Mocked: the filesystem (a Map standing
// in for disk, so writes and renames are observable), the doc store, and the
// stores it reports into. Assertions are on what reached "disk" and on whether
// the slug is still dirty afterwards — those two are the whole contract.
//
// MODULE STATE
// The dirty set, `lastWrittenPath` and the single-flight flag live at module
// scope, so each test takes a fresh module (`vi.resetModules()` + dynamic
// import). Same trap as pendingChangesApplier.test.ts: anything imported
// statically here would be a different instance than the one under test.
//
// HOW THESE WERE PROVEN TO BE ABLE TO FAIL
// Each `it` names the product mutation that must turn it red. Nine were applied
// to docFileSync.ts and observed, then reverted:
//
//   hasExternalConflict gate off        → "external conflict" failed
//   !known stops clearing dirty         → "gives up on a slug" failed
//   shouldDeferStaleWrite off           → "defers when the target vanished"
//   fileContentEquals skip removed      → "does not rewrite" failed
//   rename-on-change removed            → "renames the previous file" failed
//   clearDirtyIfUnchanged → clearDirty  → "leaves the slug dirty" failed
//   status !== 'ready' guard off        → "still loading" failed (the 0-byte bug)
//   clearDirty added to the catch       → both retry cases failed
//   reconcile call removed              → "reconciles the failure store" failed
//
// A characterization test that stays green under its own named mutation is
// guarding nothing and should be rewritten, not kept.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fake } = vi.hoisted(() => ({
  fake: {
    /** path → contents. The filesystem. */
    disk: new Map<string, string>(),
    /** Every write/rename, in order. */
    ops: [] as { op: string; path: string; to?: string }[],
    /** Paths whose write should throw. */
    failWrites: new Set<string>(),
    conflicted: new Set<string>(),
    knownDocs: [] as Record<string, unknown>[],
    handles: {} as Record<string, { bodyMarkdown: string }>,
    status: {} as Record<string, string>,
    failuresReported: [] as string[],
    reconciledWith: null as string[] | null,
    indexInvalidated: 0,
  },
}))

vi.mock('@/lib/vault', () => ({
  readVaultFile: vi.fn(async (p: string) => {
    if (!fake.disk.has(p)) throw new Error('ENOENT')
    return fake.disk.get(p)!
  }),
  writeVaultFile: vi.fn(async (p: string, content: string) => {
    if (fake.failWrites.has(p)) throw new Error('EACCES')
    fake.ops.push({ op: 'write', path: p })
    fake.disk.set(p, content)
  }),
  vaultFileExists: vi.fn(async (p: string) => fake.disk.has(p)),
  renameVaultFile: vi.fn(async (from: string, to: string) => {
    fake.ops.push({ op: 'rename', path: from, to })
    fake.disk.set(to, fake.disk.get(from)!)
    fake.disk.delete(from)
  }),
}))
vi.mock('@/state/settingsStore', () => ({ getActiveVaultPath: () => '/vault' }))
vi.mock('@/state/externalConflictStore', () => ({
  hasExternalConflict: (slug: string) => fake.conflicted.has(slug),
}))
vi.mock('@/state/docsStore', () => ({
  useDocsStore: {
    getState: () => ({
      knownDocs: fake.knownDocs,
      handles: fake.handles,
      status: fake.status,
    }),
  },
}))
vi.mock('@/state/activeCmEditor', () => ({ pullActiveCmBody: () => null }))
vi.mock('@/lib/viewUrl', () => ({ getActiveSlugFromHash: () => null }))
vi.mock('@/state/wikiIndex', () => ({
  invalidateWikiIndex: () => {
    fake.indexInvalidated++
  },
}))
vi.mock('@/state/vaultTimeline', () => ({ invalidateVaultTimeline: () => {} }))
vi.mock('@/lib/notify', () => ({ notify: new Proxy({}, { get: () => () => {} }) }))
vi.mock('@/state/saveFailureStore', () => ({
  useSaveFailureStore: {
    getState: () => ({
      recordFailure: (slug: string) => fake.failuresReported.push(slug),
      reconcile: (slugs: string[]) => {
        fake.reconciledWith = slugs
      },
      clear: () => {},
      failures: {},
    }),
    // The module subscribes at import time to drive the save-failure toast.
    subscribe: () => () => {},
  },
}))

type Mod = typeof import('./docFileSync')

/** A fresh module — the dirty set, lastWrittenPath and the single-flight flag
 * are all module scope. */
async function freshModule(): Promise<Mod> {
  vi.resetModules()
  return import('./docFileSync')
}

/** A plain sidecar-backed note, ready to flush. */
function seedDoc(slug: string, relPath: string, body: string) {
  fake.knownDocs.push({ slug, type: 'note', relPath, title: slug, fm: {} })
  fake.handles[slug] = { bodyMarkdown: body }
  fake.status[slug] = 'ready'
}

const MD = 'notes/a.md'

beforeEach(() => {
  fake.disk = new Map()
  fake.ops = []
  fake.failWrites = new Set()
  fake.conflicted = new Set()
  fake.knownDocs = []
  fake.handles = {}
  fake.status = {}
  fake.failuresReported = []
  fake.reconciledWith = null
  fake.indexInvalidated = 0
})

describe('flush: reasons to skip a slug', () => {
  // BREAKS IF: the hasExternalConflict gate is removed. The user is still
  // deciding via the banner; writing here overwrites the external version
  // behind their back. It must stay DIRTY, so the write lands once they choose.
  it('skips a slug with an unresolved external conflict, and keeps it dirty', async () => {
    const m = await freshModule()
    seedDoc('a', 'notes/a.md', '내 편집\n')
    fake.conflicted.add('a')
    m.markSlugDirty('a')

    await m.flushDirty()

    expect(fake.ops).toEqual([])
    expect(m.isDirty('a')).toBe(true)
  })

  // BREAKS IF: the `!known` branch stops calling clearDirty. A slug with no
  // catalog entry can never be written, so leaving it dirty spins the 500ms
  // flush loop on it for the rest of the session.
  it('gives up on a slug the catalog no longer knows, rather than spinning', async () => {
    const m = await freshModule()
    m.markSlugDirty('ghost')

    await m.flushDirty()

    expect(m.isDirty('ghost')).toBe(false)
    expect(fake.ops).toEqual([])
  })

  // BREAKS IF: serializeDocToFiles' `status !== 'ready'` guard is dropped, or
  // the `if (!result) continue` becomes a clearDirty. A handle still loading
  // has bodyMarkdown '' — writing that truncates the file to 0 bytes (the
  // Daniel.md incident). Skipping AND staying dirty is the pair that matters:
  // the edit must land on a later tick.
  it('never writes a handle that is still loading, and keeps it dirty', async () => {
    const m = await freshModule()
    seedDoc('a', 'notes/a.md', '')
    fake.status.a = 'loading'
    fake.disk.set(MD, '디스크에 있던 진짜 내용\n')
    m.markSlugDirty('a')

    await m.flushDirty()

    expect(fake.ops).toEqual([])
    expect(fake.disk.get(MD)).toBe('디스크에 있던 진짜 내용\n')
    expect(m.isDirty('a')).toBe(true)
  })
})

describe('flush: writing', () => {
  // Every doc type is frontmatter-native — `docPaths.usesFrontmatter` is a
  // hardcoded `true` that ignores its argument. So metadata rides inside the
  // `.md` and no `.meta.json` is ever written; the product's whole sidecar
  // branch (meta-only flush, sidecar rename, mergeSidecar) is unreachable
  // today. Pinned as it IS, not as the branch structure suggests — if that
  // function ever starts discriminating again, this is where it shows up.
  it('writes the body with its metadata embedded, and no sidecar file', async () => {
    const m = await freshModule()
    seedDoc('a', 'notes/a.md', '본문\n')
    m.markSlugDirty('a')

    await m.flushDirty()

    expect(fake.disk.get(MD)).toBe('본문\n')
    expect(fake.disk.has('notes/a.meta.json')).toBe(false)
    expect(m.isDirty('a')).toBe(false)
  })

  // BREAKS IF: the fileContentEquals short-circuit is removed. Opening a doc
  // marks it dirty even when the user never types, so without this every flush
  // rewrites untouched files and they surface as phantom changes in git and in
  // the review panel.
  it('does not rewrite a file whose content is already identical', async () => {
    const m = await freshModule()
    seedDoc('a', 'notes/a.md', '본문\n')
    fake.disk.set(MD, '본문\n')
    m.markSlugDirty('a')

    await m.flushDirty()

    expect(fake.ops.filter((o) => o.path === MD)).toEqual([])
    expect(m.isDirty('a')).toBe(false)
  })
})

describe('flush: the file moved', () => {
  // BREAKS IF: rename-on-change is removed and the flush just writes at the new
  // path. The old file is then orphaned — two files for one note, and the
  // stale one keeps showing in the sidebar.
  it('renames the previous file instead of leaving an orphan copy', async () => {
    const m = await freshModule()
    seedDoc('a', 'notes/renamed.md', '본문\n')
    fake.disk.set(MD, '본문\n')
    m.seedLastWrittenPath([{ slug: 'a', mdRel: MD }])
    m.markSlugDirty('a')

    await m.flushDirty()

    expect(fake.ops.filter((o) => o.op === 'rename').map((o) => [o.path, o.to])).toEqual([
      [MD, 'notes/renamed.md'],
    ])
    expect(fake.disk.has(MD)).toBe(false) // no orphan left behind
  })

  // BREAKS IF: the shouldDeferStaleWrite guard is removed. An external move or
  // delete is mid-flight (the OS moved the file before the watcher updated
  // relPath); writing blindly recreates a zombie at the stale path and strands
  // the live edits in it.
  it('defers when the target vanished under it, keeping the slug dirty', async () => {
    const m = await freshModule()
    seedDoc('a', 'notes/a.md', '본문\n')
    m.seedLastWrittenPath([{ slug: 'a', mdRel: MD }]) // written before…
    // …and the file is NOT on the fake disk now — an external move in flight.
    m.markSlugDirty('a')

    await m.flushDirty()

    expect(fake.ops).toEqual([])
    expect(m.isDirty('a')).toBe(true)
  })
})

describe('flush: a write that failed', () => {
  // BREAKS IF: the catch stops leaving the slug dirty (e.g. a clearDirty is
  // added "to avoid retry storms"). The retry IS the durability story — the
  // user's edit only exists in memory until one of these succeeds.
  it('keeps the slug dirty and reports the failure', async () => {
    const m = await freshModule()
    seedDoc('a', 'notes/a.md', '본문\n')
    fake.failWrites.add(MD)
    m.markSlugDirty('a')

    await m.flushDirty()

    expect(m.isDirty('a')).toBe(true)
    expect(fake.failuresReported).toContain('a')
  })

  it('retries on the next flush and clears once it lands', async () => {
    const m = await freshModule()
    seedDoc('a', 'notes/a.md', '본문\n')
    fake.failWrites.add(MD)
    m.markSlugDirty('a')
    await m.flushDirty()
    expect(m.isDirty('a')).toBe(true)

    fake.failWrites.delete(MD)
    await m.flushDirty()

    expect(fake.disk.get(MD)).toBe('본문\n')
    expect(m.isDirty('a')).toBe(false)
  })

  // BREAKS IF: reconcile stops being called with the CURRENT dirty set. The
  // save-failure toast is dismissed by this call; a recovered slug that stays
  // in the failure store leaves the banner up forever.
  it('reconciles the failure store against what is still dirty', async () => {
    const m = await freshModule()
    seedDoc('a', 'notes/a.md', '본문\n')
    m.markSlugDirty('a')

    await m.flushDirty()

    expect(fake.reconciledWith).toEqual([])
  })
})

describe('flush: an edit that arrives mid-write', () => {
  // BREAKS IF: clearDirtyIfUnchanged degrades to an unconditional clearDirty.
  // The write is awaited, so an edit can land while it is in flight; clearing
  // unconditionally drops that newer body with no error anywhere.
  it('leaves the slug dirty so the newer body flushes next tick', async () => {
    const m = await freshModule()
    seedDoc('a', 'notes/a.md', '첫 본문\n')
    m.markSlugDirty('a')

    // Land an edit while the write is awaiting, the way a keystroke does.
    const { writeVaultFile } = await import('@/lib/vault')
    vi.mocked(writeVaultFile).mockImplementationOnce(async (p: string, c: string) => {
      fake.ops.push({ op: 'write', path: p })
      fake.disk.set(p, c)
      m.markSlugDirty('a') // the user typed
    })

    await m.flushDirty()

    expect(m.isDirty('a')).toBe(true)
  })
})
