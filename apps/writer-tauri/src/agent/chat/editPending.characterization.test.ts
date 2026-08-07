// Characterization tests for the `claude:edit-pending` handler.
//
// WHY THIS FILE EXISTS
// The handler is ~320 lines living inside a `listen()` callback in
// `agent/chat/index.ts` — the per-path mutex, the merge branch, the three
// auto-accept branches, and the `ackOk` / `ackReason` / `ackApplied` verdict the
// model acts on. None of it has an importable symbol, so none of it has a test.
// `materializeRace.test.ts` says so in its own header:
//
//   "The fix for this race lives ONE LAYER UP, in agent/chat/index.ts's
//    edit-pending handler ... This test intentionally keeps calling
//    materializeChatNewWikiPage directly, with no coordination."
//
// So the fix for that race — and everything else in the handler — is currently
// unguarded. This file is the net that goes up BEFORE the handler moves out into
// its own module, so the move can be proven to change nothing.
//
// WHAT IS REAL AND WHAT IS MOCKED
// Real: the handler itself (driven through `runChat`), pendingChangesStore,
// toPendingChange's mapper / merge, wholeDocGuard's CAS policy, modelBodyBase.
// Mocked: the Tauri boundary (so events can be fired and the ack observed), and
// anything that reaches disk or the editor. The assertions read the ack sent
// back to the sidecar via `claude_chat_edit_ack`, because that IS the contract:
// it is what the model is told happened.
//
// HOW THESE WERE PROVEN TO BE ABLE TO FAIL
// A characterization test passes on unchanged code by construction, so "run it
// against the unfixed code" (repo CLAUDE.md) doesn't apply as written. The
// equivalent discipline is deliberate breakage — each `it` below names the
// product mutation that must turn it red. All five were applied to index.ts and
// observed to fail, then reverted:
//
//   mutex → Promise.resolve(null)        → "ONE note" failed: ['slug-1','slug-2']
//   noop branch ackOk = false            → "no-op" failed
//   stale outcome accepted as applied    → "diverged base" failed
//   drop ackApplied on 'applied'         → "APPLIED, not queued" failed
//   catch rethrows instead of returning  → "does not poison" failed
//
// A test here that stays green under its named mutation is guarding nothing and
// should be rewritten, not kept.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Tauri boundary ───────────────────────────────────────────────────────────
type AnyCb = (e: { payload: unknown }) => void
const listeners = new Map<string, AnyCb[]>()
const invokeCalls: { cmd: string; args: unknown }[] = []

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, cb: AnyCb) => {
    const arr = listeners.get(name) ?? []
    arr.push(cb)
    listeners.set(name, arr)
    return () => {
      const cur = listeners.get(name) ?? []
      listeners.set(
        name,
        cur.filter((c) => c !== cb),
      )
    }
  }),
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: unknown) => {
    invokeCalls.push({ cmd, args })
    return undefined
  }),
}))

// ── Disk / editor boundary ───────────────────────────────────────────────────
const { state } = vi.hoisted(() => ({
  state: {
    /** Slug → body, standing in for what is on disk / in the handle. */
    bodies: {} as Record<string, string>,
    /** Slugs minted by materialize, in order. */
    created: [] as string[],
    /** applyWriteWikiPage outcome — flipped per test. */
    writeOk: true,
    /** applyWriteWikiPageChecked stale verdict — null = the CAS passes. */
    staleLatest: null as string | null,
    navigated: [] as string[],
    notified: [] as string[],
  },
}))

vi.mock('@/state/wikiService', () => ({
  createGenericNote: vi.fn(async () => {
    // A microtask delay, so two same-turn calls genuinely overlap the way they
    // do in the app (materializeRace.test.ts makes the same point).
    await Promise.resolve()
    const slug = `slug-${state.created.length + 1}`
    state.created.push(slug)
    state.bodies[slug] = ''
    return slug
  }),
  createCustomWikiPage: vi.fn(async () => {
    await Promise.resolve()
    const slug = `slug-${state.created.length + 1}`
    state.created.push(slug)
    state.bodies[slug] = ''
    return slug
  }),
}))

vi.mock('@/agent/applyIngest', () => ({
  applyWriteWikiPage: vi.fn(async (slug: string, body: string) => {
    if (!state.writeOk) return false
    state.bodies[slug] = body
    return true
  }),
  applyWriteWikiPageChecked: vi.fn(async (slug: string, body: string) => {
    if (state.staleLatest !== null) {
      // `changedLines` is `LineRange[]` (see lib/bodyStale) — buildStaleReason
      // maps over it. A scalar here threw inside the handler's catch and the
      // refusal silently became a success, which is exactly the class of bug
      // this file exists to catch, so the shape is taken from the product type
      // rather than guessed.
      return {
        ok: false as const,
        reason: 'stale' as const,
        stale: { latest: state.staleLatest, changedLines: [{ from: 1, to: 1 }] },
      }
    }
    if (!state.writeOk) return { ok: false as const, reason: 'failed' as const }
    state.bodies[slug] = body
    return { ok: true as const }
  }),
  applyWriteWikiPageToDoc: vi.fn(async () => true),
}))

vi.mock('@/editor/cmNav', () => ({
  navigateToNoteBySlug: vi.fn((slug: string) => {
    state.navigated.push(slug)
  }),
}))
vi.mock('@/lib/notify', () => ({
  notify: new Proxy(
    {},
    {
      get: (_t, prop: string) => () => {
        state.notified.push(prop)
      },
    },
  ),
}))

// ── Stores / context the prologue reads ──────────────────────────────────────
vi.mock('@/state/docsStore', () => ({
  useDocsStore: {
    getState: () => ({
      // Empty catalog: every edit misses the mapper and falls to materialize,
      // which is the create-then-edit shape the mutex exists for.
      knownDocs: [],
      handles: {},
      ensureHandle: async () => {},
      openDaily: async () => {},
    }),
  },
}))
vi.mock('@/state/docsStore/docBody', () => ({ readDocBody: () => '' }))
vi.mock('@/agent/contextPipeline', () => ({
  assembleContext: async () => ({}),
}))
vi.mock('@/state/settingsStore', () => ({
  getActiveVaultPath: () => '/vault',
  getDefaultNoteFolder: () => 'inbox',
  getKnowledgeBaseFolder: () => 'wiki',
  getSandboxEnabled: () => true,
  getPersistentQueryEnabled: () => false,
}))
vi.mock('@/state/threadsStore', () => ({
  useThreadsStore: {
    getState: () => ({ threads: {}, updateMeta: async () => {} }),
  },
}))
vi.mock('@/state/gitStore', () => ({
  useGitStore: {
    getState: () => ({ dirtyPaths: new Set(), commitChangesNow: async () => {} }),
  },
  aiEditSubject: (s: string) => s,
}))
vi.mock('@/state/contextUsageStore', () => ({
  useContextUsageStore: { getState: () => ({ set: () => {} }) },
}))
vi.mock('@/state/fastModeStore', () => ({
  useFastModeStore: { getState: () => ({ set: () => {} }) },
}))

import { runChat } from './index'
import { usePendingChangesStore } from '@/state/pendingChangesStore'
import { createGenericNote } from '@/state/wikiService'

// ── Helpers ──────────────────────────────────────────────────────────────────

const FILE = '/vault/inbox/Meeting notes.md'

function fire(name: string, payload: unknown) {
  for (const cb of listeners.get(name) ?? []) cb({ payload })
}
/** Let the handler's promise chain drain. */
const flush = () => new Promise((r) => setTimeout(r, 0))

/** The runId `runChat` minted — every event has to carry it or it is filtered. */
function currentRunId(): string {
  const start = invokeCalls.find((c) => c.cmd === 'claude_chat_start')
  return (start?.args as { args: { runId: string } }).args.runId
}

/** Every `claude_chat_edit_ack` sent so far, oldest first. */
function acks(): { pendingId: string; ok: boolean; reason?: string; applied?: boolean }[] {
  return invokeCalls
    .filter((c) => c.cmd === 'claude_chat_edit_ack')
    .map((c) => (c.args as { args: never }).args)
}

function editPending(pendingId: string, toolName: string, input: Record<string, unknown>) {
  return { runId: currentRunId(), pendingId, toolName, input }
}

/** Start a run and wait until it has registered its listeners.
 *
 * The run's own promise is deliberately NOT returned: it settles on
 * `claude:done`, which these tests never fire, so returning it from an `async`
 * function would make `await startRun()` wait for a turn that never ends. It is
 * parked with a no-op catch instead — the tests assert on the ack, not on the
 * turn's outcome. */
async function startRun(opts: { autoAcceptEdits?: boolean } = {}): Promise<void> {
  void runChat({
    slug: 'note',
    threadId: 'thread-1',
    prompt: 'go',
    autoAcceptEdits: opts.autoAcceptEdits ?? false,
    navigateToNewNotes: false,
  }).catch(() => {})
  // `runChat` awaits its listener registrations and `claude_chat_start` before
  // the turn is live; a couple of macrotasks covers both.
  await flush()
  await flush()
}

beforeEach(() => {
  listeners.clear()
  invokeCalls.length = 0
  state.bodies = {}
  state.created = []
  state.writeOk = true
  state.staleLatest = null
  state.navigated = []
  state.notified = []
  usePendingChangesStore.setState({ byId: {} })
  vi.mocked(createGenericNote).mockClear()
})

// ─────────────────────────────────────────────────────────────────────────────

describe('edit-pending: same file twice in one turn', () => {
  // BREAKS IF: the `newNoteByPath` promise-chain mutex in index.ts is removed.
  // Without it both events take the same empty-catalog snapshot and each
  // materializes its own note — the bug materializeRace.test.ts reproduces one
  // layer down but cannot see fixed.
  it('creates ONE note and merges the second edit into it', async () => {
    await startRun()

    fire('claude:edit-pending', editPending('p1', 'Write', {
      file_path: FILE,
      content: '초안\n',
    }))
    fire('claude:edit-pending', editPending('p2', 'Edit', {
      file_path: FILE,
      old_string: '초안',
      new_string: '초안 고침',
    }))
    await flush()
    await flush()

    expect(state.created).toHaveLength(1)
    expect(vi.mocked(createGenericNote)).toHaveBeenCalledTimes(1)

    const changes = Object.values(usePendingChangesStore.getState().byId)
    expect(changes).toHaveLength(1)
    expect(changes[0].edits[0].after).toContain('초안 고침')
  })

  // BREAKS IF: the `placement.kind === 'noop'` branch stops setting
  // `ackOk = true` (index.ts). A refusal there makes the model re-propose an
  // edit that is already in the staged body, forever.
  it('reports success when the second call is a no-op', async () => {
    await startRun()

    fire('claude:edit-pending', editPending('p1', 'Write', {
      file_path: FILE,
      content: '한 줄\n',
    }))
    await flush()
    await flush()
    // Same content again — nothing left to do against the staged body.
    fire('claude:edit-pending', editPending('p2', 'Edit', {
      file_path: FILE,
      old_string: '한 줄',
      new_string: '한 줄',
    }))
    await flush()
    await flush()

    const second = acks().find((a) => a.pendingId === 'p2')
    expect(second).toBeDefined()
    expect(second!.ok).toBe(true)
  })

  // BREAKS IF: the merge branch stops calling describeRefusal / stops setting
  // `ackReason`. The model would then be told "queued" for an edit that never
  // landed against the staged body.
  it('refuses with a reason when the second edit has no anchor', async () => {
    await startRun()

    fire('claude:edit-pending', editPending('p1', 'Write', {
      file_path: FILE,
      content: '있는 줄\n',
    }))
    await flush()
    await flush()
    fire('claude:edit-pending', editPending('p2', 'Edit', {
      file_path: FILE,
      old_string: '없는 줄',
      new_string: '무엇이든',
    }))
    await flush()
    await flush()

    const second = acks().find((a) => a.pendingId === 'p2')
    expect(second).toBeDefined()
    expect(second!.ok).toBe(false)
    expect(second!.reason).toBeTruthy()
  })
})

describe('edit-pending: auto-accept', () => {
  // BREAKS IF: the `Write` branch stops routing through guardedWholeDocWrite,
  // or the 'stale' outcome stops flipping ackOk to false. Either way a stale
  // overwrite would look successful to the model and the user's edit would be
  // silently clobbered.
  it('refuses a whole-doc write whose base diverged, and keeps the card pending', async () => {
    await startRun({ autoAcceptEdits: true })

    // First write establishes the note and the model's base.
    fire('claude:edit-pending', editPending('p1', 'Write', {
      file_path: FILE,
      content: '모델이 쓴 본문\n',
    }))
    await flush()
    await flush()

    // The user typed underneath: the next CAS sees a diverged body.
    state.staleLatest = '사용자가 고친 본문\n'
    fire('claude:edit-pending', editPending('p2', 'Write', {
      file_path: '/vault/inbox/Another.md',
      content: '덮어쓰기 시도\n',
    }))
    await flush()
    await flush()

    const second = acks().find((a) => a.pendingId === 'p2')
    expect(second).toBeDefined()
    expect(second!.ok).toBe(false)
    expect(second!.reason).toBeTruthy()

    // The proposal stays pending — a refused write must not lose the content.
    const stillPending = Object.values(usePendingChangesStore.getState().byId).filter(
      (c) => c.status === 'pending',
    )
    expect(stillPending.length).toBeGreaterThan(0)
  })

  // BREAKS IF: the range-edit branch stops setting `ackApplied`. The model then
  // believes its edit is queued and tells the user to "reject the card" that
  // does not exist, because auto-accept already saved it.
  it('tells the model an auto-accepted range edit was APPLIED, not queued', async () => {
    await startRun({ autoAcceptEdits: true })

    fire('claude:edit-pending', editPending('p1', 'Write', {
      file_path: FILE,
      content: '본문 한 줄\n',
    }))
    await flush()
    await flush()

    const first = acks().find((a) => a.pendingId === 'p1')
    expect(first).toBeDefined()
    expect(first!.applied).toBe(true)
  })
})

describe('edit-pending: failure containment', () => {
  // BREAKS IF: the try/catch around the per-path tail is removed. The rejected
  // promise is exactly what is stored in `newNoteByPath`, so every later event
  // for that path would re-throw it at `await priorTail` and silently no-op —
  // a worse failure than the race the mutex closes.
  it('a throw on one path does not poison later events for the same path', async () => {
    await startRun()

    // Make the first materialize blow up.
    vi.mocked(createGenericNote).mockImplementationOnce(async () => {
      throw new Error('boom')
    })
    fire('claude:edit-pending', editPending('p1', 'Write', {
      file_path: FILE,
      content: '첫 시도\n',
    }))
    await flush()
    await flush()

    // The next event for the SAME path must still be handled.
    fire('claude:edit-pending', editPending('p2', 'Write', {
      file_path: FILE,
      content: '두 번째 시도\n',
    }))
    await flush()
    await flush()

    expect(acks().some((a) => a.pendingId === 'p2')).toBe(true)
    expect(state.created).toHaveLength(1)
  })
})
