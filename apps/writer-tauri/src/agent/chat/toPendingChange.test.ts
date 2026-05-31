import { describe, expect, it, vi, beforeEach } from 'vitest'

// createCustomWikiPage does real I/O (docsStore + IDB + Tauri). Mock it
// so we can assert the materialize logic — gating, name derivation, H1
// strip, returned PendingChange shape — without standing up the vault.
const createCustomWikiPage = vi.fn<
  (name: string, body?: string) => Promise<string | null>
>()
vi.mock('@/state/wikiService', () => ({
  createCustomWikiPage: (name: string, body?: string) =>
    createCustomWikiPage(name, body),
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

describe('materializeChatNewWikiPage', () => {
  beforeEach(() => {
    createCustomWikiPage.mockReset()
    createCustomWikiPage.mockResolvedValue('new-slug')
  })

  it('creates the page (title-only) and stages the body for a new wiki write', async () => {
    const result = await materializeChatNewWikiPage(
      payload({
        file_path: 'wiki/Sera & Daniel 결혼식 이벤트.md',
        content: '* 첫 줄\n* 둘째 줄',
      }),
      baseCtx,
    )

    // Page seeded with H1 title derived from the path basename.
    expect(createCustomWikiPage).toHaveBeenCalledWith(
      'Sera & Daniel 결혼식 이벤트',
      '# Sera & Daniel 결혼식 이벤트',
    )
    expect(result).not.toBeNull()
    expect(result!.source).toBe('chat')
    expect(result!.pageSlug).toBe('new-slug')
    expect(result!.id).toBe('pending-1')
    expect(result!.edits).toHaveLength(1)
    expect(result!.edits[0]).toMatchObject({ kind: 'add', after: '* 첫 줄\n* 둘째 줄' })
    expect(result!.context.rationale).toBe('결혼식 이벤트 페이지 만들어줘')
  })

  it('strips a leading H1 from the content so the title is not duplicated', async () => {
    const result = await materializeChatNewWikiPage(
      payload({
        file_path: 'wiki/Foo.md',
        content: '# Foo\n\n본문 첫 줄',
      }),
      baseCtx,
    )
    expect(createCustomWikiPage).toHaveBeenCalledWith('Foo', '# Foo')
    expect(result!.edits[0].after).toBe('본문 첫 줄')
  })

  it('returns null for Edit / MultiEdit (those target existing text, not new pages)', async () => {
    const edit = await materializeChatNewWikiPage(
      payload({ file_path: 'wiki/Foo.md', old_string: 'a', new_string: 'b' }, 'Edit'),
      baseCtx,
    )
    expect(edit).toBeNull()
    expect(createCustomWikiPage).not.toHaveBeenCalled()
  })

  it('returns null for non-wiki paths (daily / writing have their own placement rules)', async () => {
    const daily = await materializeChatNewWikiPage(
      payload({ file_path: 'daily/2026-05-31.md', content: 'x' }),
      baseCtx,
    )
    expect(daily).toBeNull()
    expect(createCustomWikiPage).not.toHaveBeenCalled()
  })

  it('returns null when content is empty', async () => {
    const empty = await materializeChatNewWikiPage(
      payload({ file_path: 'wiki/Foo.md', content: '   ' }),
      baseCtx,
    )
    expect(empty).toBeNull()
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
    expect(createCustomWikiPage).not.toHaveBeenCalled()
  })

  it('drops the proposal (null) when page creation fails', async () => {
    createCustomWikiPage.mockResolvedValue(null)
    const result = await materializeChatNewWikiPage(
      payload({ file_path: 'wiki/Foo.md', content: 'body' }),
      baseCtx,
    )
    expect(result).toBeNull()
  })
})
