import { describe, expect, it, vi, beforeEach } from 'vitest'

// Reproduces the audit's "create-then-edit in one turn" race (pattern A):
// agent/chat/index.ts's edit-pending handler snapshots `knownDocs` once per
// event and runs fully async (createGenericNote awaits ensureHandle before
// resolving). If two events for the SAME file_path (e.g. Write then Edit,
// both targeting a not-yet-existing note) arrive close enough together, BOTH
// handler invocations take their knownDocs snapshot before either note
// exists — so neither resolves an existing slug, and BOTH fall through to
// materializeChatNewWikiPage, creating TWO real notes for what was meant to
// be one file. This test calls the exported materialize function directly
// (bypassing the event system) with the same ctx for both calls, which is
// exactly what happens when two edit-pending events race on the same
// knownDocs snapshot.
const createGenericNote = vi.fn<
  (name: string, folder: string) => Promise<string | null>
>()
const createCustomWikiPage = vi.fn<(name: string) => Promise<string | null>>()
vi.mock('@/state/wikiService', () => ({
  createGenericNote: (...args: [string, string]) => createGenericNote(...args),
  createCustomWikiPage: (...args: [string]) => createCustomWikiPage(...args),
}))
vi.mock('@/state/settingsStore', () => ({
  getDefaultNoteFolder: () => 'inbox',
}))

import { materializeChatNewWikiPage } from './toPendingChange'
import type { KnownDoc } from '@/state/docsStore'

function payload(input: Record<string, unknown>, toolName: string, pendingId: string) {
  return { runId: 'run-1', pendingId, toolName, input }
}

describe('materialize race (no per-file coordination)', () => {
  beforeEach(() => {
    let n = 0
    createGenericNote.mockReset()
    // Simulate real I/O latency (ensureHandle/flushDirty) with a microtask
    // delay, and return a distinct slug per call so we can tell them apart.
    createGenericNote.mockImplementation(async () => {
      const my = ++n // capture BEFORE the await — n is shared/mutable, so
      await Promise.resolve() // reading it after the await would itself race
      return `slug-${my}`
    })
  })

  it('REPRODUCES the bug: two concurrent calls for the same file_path create TWO notes', async () => {
    // Same ctx snapshot for both — this is what happens today: index.ts reads
    // `useDocsStore.getState().knownDocs` fresh per event, but if event #2
    // fires before event #1's createGenericNote has registered the new doc,
    // #2's snapshot is identical to #1's (the new note isn't in it yet).
    const ctx = {
      knownDocs: [] as KnownDoc[],
      vaultPath: null,
      threadId: 'thread-1',
      userRequest: 'make a note',
    }

    // Event #1: Write (creates the note). Event #2: Edit arriving on the
    // SAME not-yet-existing file_path (the "create-then-edit" pattern) — in
    // toPendingChange.ts's real flow this only reaches materialize after
    // mapChatEditToPendingChange already returned null for BOTH, which is
    // exactly the case when ctx.knownDocs doesn't yet contain the note.
    const [write, edit] = await Promise.all([
      materializeChatNewWikiPage(
        payload({ file_path: 'Meeting notes.md', content: '초안' }, 'Write', 'p1'),
        ctx,
      ),
      materializeChatNewWikiPage(
        payload(
          { file_path: 'Meeting notes.md', old_string: '', new_string: '추가 내용' },
          'Edit',
          'p2',
        ),
        ctx,
      ),
    ])

    // Today's (buggy) behavior: BOTH materialize, because neither call knows
    // about the other — there's no shared "this file is already being
    // created in this turn" state. This assertion documents the bug; it
    // should FLIP to `toHaveBeenCalledTimes(1)` once the per-turn/per-file
    // coordination (staging) fix lands.
    expect(createGenericNote).toHaveBeenCalledTimes(2)
    expect(write).not.toBeNull()
    expect(edit).not.toBeNull()
    // Two DIFFERENT slugs — two real notes for one intended file.
    expect(write!.pageSlug).not.toBe(edit!.pageSlug)
  })
})
