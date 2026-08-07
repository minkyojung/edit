// The handler driven directly, which is the thing Phase 1 bought: before the
// extraction there was no symbol here to call, so `writes` could only have been
// tested through a whole `runChat`.
//
// What is under test is NOT that turnWrites works — turnWrites.test.ts covers
// that, and a pure map is easy to make pass. It is that the recording is
// actually WIRED: that an auto-accepted write goes through `keepBefore` on its
// way to disk, and that an interactive run records nothing because it writes
// nothing.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { state } = vi.hoisted(() => ({
  state: {
    bodies: {} as Record<string, string>,
    knownDocs: [] as { slug: string; relPath?: string; type?: string }[],
  },
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))
vi.mock('@/state/docsStore/docBody', () => ({
  readDocBody: (slug: string) => state.bodies[slug] ?? '',
}))
vi.mock('@/state/docsStore', () => ({
  useDocsStore: {
    getState: () => ({
      knownDocs: state.knownDocs,
      handles: {},
      ensureHandle: async () => {},
      openDaily: async () => {},
    }),
  },
}))
vi.mock('@/state/settingsStore', () => ({
  getActiveVaultPath: () => '/vault',
  getDefaultNoteFolder: () => 'inbox',
}))
vi.mock('@/agent/applyIngest', () => ({
  applyWriteWikiPage: vi.fn(async (slug: string, body: string) => {
    state.bodies[slug] = body
    return true
  }),
  applyWriteWikiPageChecked: vi.fn(async (slug: string, body: string) => {
    state.bodies[slug] = body
    return { ok: true as const }
  }),
  applyWriteWikiPageToDoc: vi.fn(async () => true),
}))
vi.mock('@/state/wikiService', () => ({
  createGenericNote: vi.fn(async () => 'new-slug'),
  createCustomWikiPage: vi.fn(async () => 'new-slug'),
}))
vi.mock('@/editor/cmNav', () => ({ navigateToNoteBySlug: vi.fn() }))
vi.mock('@/lib/notify', () => ({
  notify: new Proxy({}, { get: () => () => {} }),
}))

import { createEditPendingHandler } from './editPendingListener'
import { usePendingChangesStore } from '@/state/pendingChangesStore'

const RUN = 'run-1'
const SLUG = 'meeting'
const FILE = '/vault/inbox/meeting.md'

function handler(autoAcceptEdits: boolean) {
  return createEditPendingHandler({
    runId: RUN,
    threadId: 'thread-1',
    autoAcceptEdits,
    navigateToNewNotes: false,
    triggeringRequest: undefined,
  })
}

function proposal(pendingId: string, toolName: string, input: Record<string, unknown>) {
  return { runId: RUN, pendingId, toolName, input }
}

beforeEach(() => {
  // An existing note, so the mapper resolves it and no materialize is involved.
  state.knownDocs = [{ slug: SLUG, relPath: 'inbox/meeting.md', type: 'note' }]
  state.bodies = { [SLUG]: '사용자가 쓴 원문\n' }
  usePendingChangesStore.setState({ byId: {} })
})

describe('turnWrites is wired into the auto-accept write path', () => {
  it('catches what the note held before an auto-accepted whole-doc write', async () => {
    const h = handler(true)
    await h.handle(proposal('p1', 'Write', { file_path: FILE, content: '모델이 덮어쓴 본문\n' }))

    expect(h.writes.isEmpty()).toBe(false)
    expect(h.writes.before()).toEqual([[SLUG, '사용자가 쓴 원문\n']])
    // And the write did happen — otherwise "before" would be trivially right.
    expect(state.bodies[SLUG]).toBe('모델이 덮어쓴 본문\n')
  })

  it('records nothing on an interactive run — a staged proposal writes nothing', async () => {
    const h = handler(false)
    await h.handle(proposal('p1', 'Write', { file_path: FILE, content: '제안만\n' }))

    expect(h.writes.isEmpty()).toBe(true)
    expect(state.bodies[SLUG]).toBe('사용자가 쓴 원문\n') // untouched
  })

  it('keeps the text from before the TURN, not from before the second write', async () => {
    const h = handler(true)
    await h.handle(proposal('p1', 'Write', { file_path: FILE, content: '첫 번째\n' }))
    await h.handle(proposal('p2', 'Write', { file_path: FILE, content: '두 번째\n' }))

    expect(h.writes.before()).toEqual([[SLUG, '사용자가 쓴 원문\n']])
  })

  it('is scoped to one turn — a new handler starts empty', async () => {
    const first = handler(true)
    await first.handle(proposal('p1', 'Write', { file_path: FILE, content: 'x\n' }))
    expect(first.writes.isEmpty()).toBe(false)

    expect(handler(true).writes.isEmpty()).toBe(true)
  })
})
