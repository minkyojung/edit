// Characterization tests for the watcher's reload path — what happens when a
// file changes on disk under us.
//
// WHY THIS FILE EXISTS
// vaultWatcher.ts is 724 lines. Its existing test covers five exported pure
// helpers and nothing that actually handles an event. The reload handler is the
// one that decides between "quietly reload" and "stop and ask the user", and it
// is the counterpart to the gate covered in docFileSyncFlush.test.ts: this is
// what SETS the external-conflict flag, that is what respects it. Testing one
// without the other leaves the pair unverified in the middle, which is where a
// silent clobber would live.
//
// WHAT IS REAL AND WHAT IS MOCKED
// Real: the watcher's event routing, its filters, and the real
// externalConflictStore — the flag is the whole subject, so faking it would
// test nothing. Mocked: the Tauri watch subscription (so events can be fired),
// the filesystem, and the doc store.
//
// HOW THESE WERE PROVEN TO BE ABLE TO FAIL
// Each `it` names the product mutation that must turn it red. Five were applied
// to vaultWatcher.ts and observed, then reverted:
//
//   isDirty branch off            → all four conflict cases failed
//   hasConflict short-circuit off → "does not stack a second toast" failed
//   onDismiss stops resolving     → "Dismiss clears the flag" failed
//   noteActivity moved below the gates → "not open at all" failed
//   onReopen resolves before reloading → "reloads FIRST" failed
//
// That last one is why the ordering test records how many reloads had happened
// AT the moment the flag was cleared, rather than asserting that both occurred:
// the weaker form passes with the order reversed, which is the only thing it is
// there to catch.

import { describe, it, expect, vi, beforeEach } from 'vitest'

type WatchCb = (event: { type: unknown; paths: string[] }) => void

const { fake } = vi.hoisted(() => ({
  fake: {
    cb: null as WatchCb | null,
    /** Slugs the app believes have unsaved edits. */
    dirty: new Set<string>(),
    /** Paths whose current bytes we already know — our own write, an echo. */
    known: new Set<string>(),
    knownDocs: [] as Record<string, unknown>[],
    handles: {} as Record<string, unknown>,
    reloaded: [] as string[],
    activity: [] as string[],
    /** The conflict toast, captured so its actions can be invoked. */
    toast: null as { fileName: string; onReopen: () => void; onDismiss: () => void } | null,
    toastCount: 0,
  },
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  watchImmediate: vi.fn(async (_p: string, cb: WatchCb) => {
    fake.cb = cb
    return () => {
      fake.cb = null
    }
  }),
}))
vi.mock('@tauri-apps/api/path', () => ({ normalize: async (p: string) => p }))
vi.mock('@/state/settingsStore', () => ({ getActiveVaultPath: () => '/vault' }))
vi.mock('./vault', () => ({
  isDiskContentKnown: async (rel: string) => fake.known.has(rel),
  hashContent: async (s: string) => `h(${s})`,
  readVaultFile: async () => '',
  vaultFileExists: async () => true,
  listVaultTreeRecursive: async () => [],
}))
vi.mock('./docFileSync', () => ({ isDirty: (slug: string) => fake.dirty.has(slug) }))
vi.mock('@/state/docsStore', () => ({
  useDocsStore: {
    getState: () => ({
      knownDocs: fake.knownDocs,
      handles: fake.handles,
      reloadFromVault: async (slug: string) => {
        fake.reloaded.push(slug)
      },
      refreshFolders: async () => {},
    }),
  },
}))
vi.mock('@/state/docsStore/helpers', () => ({
  findSlugByVaultPath: (docs: { slug: string; relPath: string }[], rel: string) =>
    docs.find((d) => d.relPath === rel)?.slug ?? null,
}))
vi.mock('@/state/gitStore', () => ({
  useGitStore: {
    getState: () => ({
      noteActivity: (rel: string) => fake.activity.push(rel),
    }),
  },
}))
vi.mock('./notify', () => ({
  notify: new Proxy(
    {},
    {
      get: (_t, prop: string) => (arg: unknown) => {
        if (prop === 'externalEditConflict') {
          fake.toastCount++
          fake.toast = arg as typeof fake.toast
        }
      },
    },
  ),
}))
vi.mock('./scanVault', () => ({ buildKnownDocForExternalPath: () => null }))
vi.mock('@/state/wikiIndex', () => ({ invalidateWikiIndex: () => {} }))
vi.mock('@/state/vaultTimeline', () => ({ invalidateVaultTimeline: () => {} }))
vi.mock('@/state/artifactRevisionStore', () => ({ bumpArtifactRevision: () => {} }))

import { startVaultWatcher, stopVaultWatcher } from './vaultWatcher'
import { useExternalConflictStore } from '@/state/externalConflictStore'

const REL = 'wiki/Note.md'

/** A plain "the file changed" fsevent, the shape Tauri emits on macOS. */
function modifyEvent(rel: string) {
  return { type: { modify: { kind: 'data' } }, paths: [`/vault/${rel}`] }
}

/** Fire an event and let the async echo check settle. */
async function fire(event: { type: unknown; paths: string[] }) {
  fake.cb?.(event)
  for (let i = 0; i < 6; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

function openDoc(slug: string, relPath: string) {
  fake.knownDocs.push({ slug, relPath, title: slug, type: 'wiki' })
  fake.handles[slug] = {}
}

beforeEach(async () => {
  fake.dirty = new Set()
  fake.known = new Set()
  fake.knownDocs = []
  fake.handles = {}
  fake.reloaded = []
  fake.activity = []
  fake.toast = null
  fake.toastCount = 0
  useExternalConflictStore.setState({ conflicts: new Set() })
  await startVaultWatcher()
})

describe('watcher: an external edit to a doc with no unsaved changes', () => {
  it('reloads it, with no conflict and no toast', async () => {
    openDoc('note', REL)
    await fire(modifyEvent(REL))

    expect(fake.reloaded).toEqual(['note'])
    expect(fake.toastCount).toBe(0)
    expect(useExternalConflictStore.getState().hasConflict('note')).toBe(false)
  })

  // BREAKS IF: the echo check (`isDiskContentKnown`) is dropped. Our own flush
  // writes the file, the watcher fires, and without this the app reloads its
  // own write — which at best churns and at worst races the buffer.
  it('ignores our own write entirely', async () => {
    openDoc('note', REL)
    fake.known.add(REL)

    await fire(modifyEvent(REL))

    expect(fake.reloaded).toEqual([])
    expect(fake.activity).toEqual([])
  })
})

describe('watcher: an external edit to a doc WITH unsaved changes', () => {
  // BREAKS IF: the isDirty branch is removed. Reloading would discard the
  // user's unsaved edits; flushing would discard the external ones. Neither
  // side may be picked automatically — that is the whole point of the flag,
  // and docFileSyncFlush.test.ts covers the other half (flush skips it).
  it('marks a conflict and does NOT reload', async () => {
    openDoc('note', REL)
    fake.dirty.add('note')

    await fire(modifyEvent(REL))

    expect(fake.reloaded).toEqual([])
    expect(useExternalConflictStore.getState().hasConflict('note')).toBe(true)
    expect(fake.toastCount).toBe(1)
  })

  // BREAKS IF: the `hasConflict` short-circuit is removed. macOS coalesces
  // rename+modify into a burst, so a single external save can arrive as two
  // events — and the user would get a stack of identical toasts for one edit.
  it('does not stack a second toast for the same conflict', async () => {
    openDoc('note', REL)
    fake.dirty.add('note')

    await fire(modifyEvent(REL))
    await fire(modifyEvent(REL))

    expect(fake.toastCount).toBe(1)
  })

  // BREAKS IF: onDismiss stops resolving the conflict. flushDirty skips a
  // conflicted slug, so the flag outliving the toast means the user's edits
  // never reach disk again for the rest of the session — silently.
  it('Dismiss clears the flag, so the pending write can land again', async () => {
    openDoc('note', REL)
    fake.dirty.add('note')
    await fire(modifyEvent(REL))

    fake.toast!.onDismiss()

    expect(useExternalConflictStore.getState().hasConflict('note')).toBe(false)
    expect(fake.reloaded).toEqual([]) // Dismiss keeps LOCAL — no reload
  })

  // BREAKS IF: onReopen resolves before the reload resolves. Auto-flush is
  // gated on the flag; clearing it first lets a flush tick land the local body
  // between the two, writing exactly what the user asked to discard.
  it('Reopen reloads FIRST and only then clears the flag', async () => {
    openDoc('note', REL)
    fake.dirty.add('note')
    await fire(modifyEvent(REL))

    // Capture WHAT HAD ALREADY HAPPENED at the moment the flag was cleared.
    // Asserting that both the reload and the resolve occurred would pass with
    // the order reversed, which is the only thing this test is about.
    let reloadsAtResolveTime: number | null = null
    const origResolve = useExternalConflictStore.getState().resolveConflict
    useExternalConflictStore.setState({
      resolveConflict: (s: string) => {
        reloadsAtResolveTime = fake.reloaded.length
        origResolve(s)
      },
    } as never)

    fake.toast!.onReopen()
    for (let i = 0; i < 6; i++) await Promise.resolve()

    expect(fake.reloaded).toEqual(['note'])
    expect(reloadsAtResolveTime).toBe(1) // the reload had already landed
    expect(useExternalConflictStore.getState().hasConflict('note')).toBe(false)
  })
})

describe('watcher: git sees the change even when the app cannot', () => {
  // BREAKS IF: noteActivity moves below the slug/handle gates. An external edit
  // to a note that is not open (the CLI editing a file, Obsidian in another
  // window) would then never reach git, so the next commit would miss it — the
  // reason it runs before the gates rather than after.
  it('records activity for a doc that is not open at all', async () => {
    // No openDoc call — nothing in the catalog, no handle.
    await fire(modifyEvent(REL))

    expect(fake.activity).toEqual([REL])
    expect(fake.reloaded).toEqual([])
  })

  // BREAKS IF: ACTIVITY_PREFIXES widens to cover app-internal paths. `_system/`
  // holds host-owned pages; routing those into git would put the app's own
  // bookkeeping into the user's history.
  it('does not record activity for app-internal paths', async () => {
    await fire(modifyEvent('_system/agent/CLAUDE.md'))

    expect(fake.activity).toEqual([])
  })
})

describe('watcher: teardown', () => {
  it('stops delivering events once stopped', async () => {
    openDoc('note', REL)
    stopVaultWatcher()

    expect(fake.cb).toBeNull()
  })
})
