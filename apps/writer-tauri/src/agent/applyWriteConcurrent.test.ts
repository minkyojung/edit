// Reproduces R1: accepting a whole-file `propose_write` overwrites edits the
// user made AFTER the proposal (between proposal and Keep). applyWriteWikiPage
// uses transform = () => content, ignoring the live bodyMarkdown entirely.
import { describe, it, expect, vi } from 'vitest'

// Shared mutable handle, hoisted so the vi.mock factories can close over it.
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

describe('propose_write accept vs concurrent user edit', () => {
  // KNOWN BUG (R1) — still open until the Cursor-style review lands (Stage 3:
  // whole-file Write rendered as frozen-old + editable-green, accept applies the
  // edited green). `it.fails` documents the data-loss and will flip to FAILING
  // the moment it's fixed, prompting us to switch this back to `it`.
  it.fails('PRESERVES the line the user edited after the proposal', async () => {
    // AI's whole-file Write proposal: only line 1 changes; line 2 is ORIGINAL.
    const aiContent = '사과는 빨갛게 익었다.\n바나나는 노랗다.'

    // User edits line 2 ("고 달다") AFTER the proposal, before pressing Keep.
    handle.bodyMarkdown = '사과는 빨갛다.\n바나나는 노랗고 달다.'

    await applyWriteWikiPage('note', aiContent)

    // Correct system: the user's interim edit survives.
    expect(handle.bodyMarkdown).toContain('달다')
  })
})
