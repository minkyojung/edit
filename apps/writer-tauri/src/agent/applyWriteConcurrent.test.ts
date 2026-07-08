// applyWriteWikiPage is a WHOLESALE overwrite (transform = () => content) — by
// design. The original R1 hazard ("a whole-file Write accept clobbers edits the
// user made after the proposal") is NOT prevented inside this function; it's
// prevented one layer up:
//   • the in-buffer review (Cursor-style) owns mounted-editor accepts — Keep
//     deletes only the RED span, so the user's edits OUTSIDE it survive, and
//   • the applier SKIPS in-buffer-materialized changes (isChangeMaterializedInActiveCm),
//     so this wholesale path isn't even reached when an editor is showing the
//     proposal. The fallback path it remains used for (note not open in any editor)
//     can't have concurrent in-editor edits to lose.
// This test pins that contract: the function itself overwrites; the safety is
// architectural, not here. (It replaces the old `it.fails` R1 reproduction.)
import { describe, it, expect, vi } from 'vitest'

const { handle } = vi.hoisted(() => ({ handle: { bodyMarkdown: '' } }))

vi.mock('@/state/activeCmEditor', () => ({
  applyMarkdownToActiveCmEditor: () => false, // not the active editor → dirty path
}))
vi.mock('@/lib/docFileSync', () => ({ markSlugDirty: () => {} }))
vi.mock('@/state/docsStore', () => ({
  useDocsStore: {
    getState: () => ({
      knownDocs: [{ slug: 'note', archivedAt: null }],
      ensureHandle: async () => {},
      handles: { note: handle },
    }),
  },
}))

import { applyWriteWikiPage } from './applyIngest'

describe('applyWriteWikiPage — wholesale overwrite (fallback path)', () => {
  it('replaces the body with the proposal content verbatim', async () => {
    const aiContent = '사과는 빨갛게 익었다.\n바나나는 노랗다.'
    handle.bodyMarkdown = '사과는 빨갛다.\n바나나는 노랗다.'

    await applyWriteWikiPage('note', aiContent)

    expect(handle.bodyMarkdown).toBe(aiContent) // whole body = the proposal
  })
})
