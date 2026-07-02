import { describe, expect, it, vi, beforeEach } from 'vitest'

// The note-creation helpers do real I/O (docsStore + IDB + Tauri). Mock them so
// we can assert the materialize logic — folder routing, name derivation, H1
// strip, create-on-miss, returned PendingChange shape — without a vault.
// The model's chosen folder is now HONORED (a `wiki/` path → a real wiki page
// via createCustomWikiPage; any other folder → a generic note there; a bare
// filename → the default folder). This replaced the old "host-forced inbox".
const createGenericNote = vi.fn<
  (name: string, folder: string) => Promise<string | null>
>()
const createCustomWikiPage = vi.fn<(name: string) => Promise<string | null>>()
vi.mock('@/state/wikiService', () => ({
  createGenericNote: (...args: [string, string]) => createGenericNote(...args),
  createCustomWikiPage: (...args: [string]) => createCustomWikiPage(...args),
}))
// Pin the default folder so bare-filename placement assertions are deterministic.
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

describe('materializeChatNewWikiPage (model-chosen placement)', () => {
  beforeEach(() => {
    createGenericNote.mockReset()
    createGenericNote.mockResolvedValue('new-slug')
    createCustomWikiPage.mockReset()
    createCustomWikiPage.mockResolvedValue('new-slug')
  })

  it('routes a wiki/ path to a real wiki page and stages the body', async () => {
    const result = await materializeChatNewWikiPage(
      payload({
        file_path: 'wiki/Sera & Daniel 결혼식 이벤트.md',
        content: '* 첫 줄\n* 둘째 줄',
      }),
      baseCtx,
    )

    // wiki/ → createCustomWikiPage (so it lands in the index and links resolve);
    // the generic-note path is NOT taken. Body is staged, not seeded.
    expect(createCustomWikiPage).toHaveBeenCalledWith('Sera & Daniel 결혼식 이벤트')
    expect(createGenericNote).not.toHaveBeenCalled()
    expect(result).not.toBeNull()
    expect(result!.source).toBe('chat')
    expect(result!.pageSlug).toBe('new-slug')
    expect(result!.id).toBe('pending-1')
    expect(result!.createdNewNote).toBe(true)
    expect(result!.edits).toHaveLength(1)
    expect(result!.edits[0]).toMatchObject({ kind: 'add', after: '* 첫 줄\n* 둘째 줄' })
    expect(result!.context.rationale).toBe('결혼식 이벤트 페이지 만들어줘')
  })

  it('falls back to the default folder for a bare filename', async () => {
    const result = await materializeChatNewWikiPage(
      payload({ file_path: 'Quick note.md', content: 'x' }),
      baseCtx,
    )
    expect(result).not.toBeNull()
    expect(createGenericNote).toHaveBeenCalledWith('Quick note', 'inbox')
    expect(createCustomWikiPage).not.toHaveBeenCalled()
  })

  it("honors the model's chosen non-wiki folder", async () => {
    const result = await materializeChatNewWikiPage(
      payload({ file_path: 'projects/Launch Plan.md', content: 'x' }),
      baseCtx,
    )
    expect(result).not.toBeNull()
    expect(createGenericNote).toHaveBeenCalledWith('Launch Plan', 'projects')
  })

  it('strips a leading H1 only when it equals the title (the duplicate-title case)', async () => {
    const result = await materializeChatNewWikiPage(
      payload({ file_path: 'Foo.md', content: '# Foo\n\n본문 첫 줄' }),
      baseCtx,
    )
    expect(createGenericNote).toHaveBeenCalledWith('Foo', 'inbox')
    expect(result!.edits[0].after).toBe('본문 첫 줄')
  })

  it('strips echoed frontmatter from the staged body (Fix 1)', async () => {
    // The model reads notes via Read (which exposes the `---` block) and may echo
    // it back into propose_write content. It must never reach the body.
    const result = await materializeChatNewWikiPage(
      payload({
        file_path: 'Foo.md',
        content: '---\nslug: gv46mqpy\ntype: note\n---\n\n실제 본문 첫 줄',
      }),
      baseCtx,
    )
    expect(result!.edits[0].after).toBe('실제 본문 첫 줄')
  })

  it('preserves a leading heading that is NOT the title (real section header)', async () => {
    const result = await materializeChatNewWikiPage(
      payload({ file_path: 'Foo.md', content: '# 배경\n내용' }),
      baseCtx,
    )
    expect(result!.edits[0].after).toBe('# 배경\n내용')
  })

  it('creates-on-miss for Edit, staging new_string as the new note body', async () => {
    // An Edit whose path doesn't resolve is a create-on-miss: the note doesn't
    // exist yet, so the new text IS the body (nothing to replace).
    const result = await materializeChatNewWikiPage(
      payload({ file_path: 'Foo.md', old_string: 'a', new_string: 'b' }, 'Edit'),
      baseCtx,
    )
    expect(result).not.toBeNull()
    expect(createGenericNote).toHaveBeenCalledWith('Foo', 'inbox')
    expect(result!.edits[0]).toMatchObject({ kind: 'add', after: 'b' })
  })

  it('creates-on-miss for MultiEdit, joining the edits into the body', async () => {
    const result = await materializeChatNewWikiPage(
      payload(
        { file_path: 'Foo.md', edits: [{ new_string: 'one' }, { new_string: 'two' }] },
        'MultiEdit',
      ),
      baseCtx,
    )
    expect(result).not.toBeNull()
    expect(result!.edits[0].after).toBe('one\ntwo')
  })

  it('returns null when content is empty', async () => {
    const empty = await materializeChatNewWikiPage(
      payload({ file_path: 'Foo.md', content: '   ' }),
      baseCtx,
    )
    expect(empty).toBeNull()
    expect(createGenericNote).not.toHaveBeenCalled()
    expect(createCustomWikiPage).not.toHaveBeenCalled()
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
    expect(createCustomWikiPage).not.toHaveBeenCalled()
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
