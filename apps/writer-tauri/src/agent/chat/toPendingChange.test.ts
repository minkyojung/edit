import { describe, expect, it, vi, beforeEach } from 'vitest'

// createGenericNote does real I/O (docsStore + IDB + Tauri). Mock it so we can assert
// the materialize logic — gating, name derivation, H1 strip, host-forced placement,
// returned PendingChange shape — without standing up the vault.
const createGenericNote = vi.fn<
  (name: string, folder: string) => Promise<string | null>
>()
vi.mock('@/state/wikiService', () => ({
  createGenericNote: (...args: [string, string]) => createGenericNote(...args),
}))
// Pin the default folder so placement assertions are deterministic.
vi.mock('@/state/settingsStore', () => ({
  getDefaultNoteFolder: () => 'inbox',
}))

import { materializeChatNewWikiPage } from './toPendingChange'
import type { KnownDoc } from '@/state/docsStore'

const baseCtx = {
  knownDocs: [] as KnownDoc[],
  vaultPath: null,
  threadId: 'thread-1',
  userRequest: '결혼식 이벤트 페이지 만들어줘',
}

function payload(input: Record<string, unknown>, toolName = 'Write') {
  return { runId: 'run-1', pendingId: 'pending-1', toolName, input }
}

describe('materializeChatNewWikiPage (host-forced placement)', () => {
  beforeEach(() => {
    createGenericNote.mockReset()
    createGenericNote.mockResolvedValue('new-slug')
  })

  it('creates an EMPTY note in the default folder and stages the body for a new write', async () => {
    const result = await materializeChatNewWikiPage(
      payload({
        file_path: 'wiki/Sera & Daniel 결혼식 이벤트.md',
        content: '* 첫 줄\n* 둘째 줄',
      }),
      baseCtx,
    )

    // Filename from the model, folder FORCED to the configured default ('inbox') — the
    // model's `wiki/` is discarded. Body is staged, not seeded.
    expect(createGenericNote).toHaveBeenCalledWith('Sera & Daniel 결혼식 이벤트', 'inbox')
    expect(result).not.toBeNull()
    expect(result!.source).toBe('chat')
    expect(result!.pageSlug).toBe('new-slug')
    expect(result!.id).toBe('pending-1')
    expect(result!.edits).toHaveLength(1)
    expect(result!.edits[0]).toMatchObject({ kind: 'add', after: '* 첫 줄\n* 둘째 줄' })
    expect(result!.context.rationale).toBe('결혼식 이벤트 페이지 만들어줘')
  })

  it('forces the default folder even when the model chose a different one', async () => {
    // Used to return null for non-wiki paths; now ANY folder the model picks is
    // discarded and the note lands in the default folder.
    const result = await materializeChatNewWikiPage(
      payload({ file_path: 'daily/2026-05-31.md', content: 'x' }),
      baseCtx,
    )
    expect(result).not.toBeNull()
    expect(createGenericNote).toHaveBeenCalledWith('2026-05-31', 'inbox')
  })

  it('strips a leading H1 only when it equals the title (the duplicate-title case)', async () => {
    const result = await materializeChatNewWikiPage(
      payload({ file_path: 'Foo.md', content: '# Foo\n\n본문 첫 줄' }),
      baseCtx,
    )
    expect(createGenericNote).toHaveBeenCalledWith('Foo', 'inbox')
    expect(result!.edits[0].after).toBe('본문 첫 줄')
  })

  it('preserves a leading heading that is NOT the title (real section header)', async () => {
    const result = await materializeChatNewWikiPage(
      payload({ file_path: 'Foo.md', content: '# 배경\n내용' }),
      baseCtx,
    )
    expect(result!.edits[0].after).toBe('# 배경\n내용')
  })

  it('returns null for Edit / MultiEdit (those target existing text, not new notes)', async () => {
    const edit = await materializeChatNewWikiPage(
      payload({ file_path: 'Foo.md', old_string: 'a', new_string: 'b' }, 'Edit'),
      baseCtx,
    )
    expect(edit).toBeNull()
    expect(createGenericNote).not.toHaveBeenCalled()
  })

  it('returns null when content is empty', async () => {
    const empty = await materializeChatNewWikiPage(
      payload({ file_path: 'Foo.md', content: '   ' }),
      baseCtx,
    )
    expect(empty).toBeNull()
    expect(createGenericNote).not.toHaveBeenCalled()
  })

  it('returns null when the path already resolves to an existing doc', async () => {
    const existing: KnownDoc = {
      slug: 'existing-slug',
      type: 'wiki:custom-abc',
      title: 'Existing',
    }
    const result = await materializeChatNewWikiPage(
      payload({ file_path: 'wiki/Existing.md', content: 'new body' }),
      { ...baseCtx, knownDocs: [existing] },
    )
    expect(result).toBeNull()
    expect(createGenericNote).not.toHaveBeenCalled()
  })

  it('drops the proposal (null) when note creation fails', async () => {
    createGenericNote.mockResolvedValue(null)
    const result = await materializeChatNewWikiPage(
      payload({ file_path: 'Foo.md', content: 'body' }),
      baseCtx,
    )
    expect(result).toBeNull()
  })
})
