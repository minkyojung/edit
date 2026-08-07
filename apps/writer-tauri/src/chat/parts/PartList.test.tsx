// The duplicate-shell rule, pinned.
//
// A turn that creates a note AND edits it fires two proposals for the same
// file. Only one resolves to a live store change; the other is a
// non-actionable shell. PartList hides the shell so the user sees one
// actionable row — get this wrong and you either show a ghost card that does
// nothing when clicked, or hide the real one.
//
// There was no test for it, and the rule reads the pending-changes store, so
// it is exactly what a change to that subscription can break.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessagePart } from '@/chat/types'
import { usePendingChangesStore } from '@/state/pendingChangesStore'
import { PROPOSE_EDIT_TOOLS } from './proposeChangeTool'

// Stand in for the card so we count PartList's DECISION, not the card's own
// rendering (which depends on the docs store and would drag half the app in).
vi.mock('@/chat/suggestions/InlineSuggestion', () => ({
  InlineSuggestion: ({ part }: { part: { id: string } }) => (
    <div data-edit-card={part.id} />
  ),
}))

const { PartList } = await import('./PartList')

const edit = (id: string, pendingId: string, filePath: string): MessagePart =>
  ({
    id,
    ts: 0,
    type: 'tool',
    toolName: PROPOSE_EDIT_TOOLS[0],
    pendingId,
    input: { file_path: filePath },
    state: 'output-available',
  }) as unknown as MessagePart

function renderCards(parts: MessagePart[]): string[] {
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() => root.render(<PartList parts={parts} isStreaming={false} />))
  const ids = [...host.querySelectorAll('[data-edit-card]')].map(
    (el) => el.getAttribute('data-edit-card') ?? '',
  )
  act(() => root.unmount())
  return ids
}

const makeLive = (pendingId: string, slug: string) =>
  act(() => {
    usePendingChangesStore.getState().push({
      id: pendingId,
      pageSlug: slug,
      source: 'chat',
      edits: [{ before: 'a', after: 'b' }],
    } as never)
  })

beforeEach(() => usePendingChangesStore.setState({ byId: {} }))
afterEach(() => usePendingChangesStore.setState({ byId: {} }))

describe('edit proposal visibility', () => {
  it('hides the shell when a live proposal covers the same file', () => {
    makeLive('live-1', 'note')
    const cards = renderCards([
      edit('shell', 'never-landed', 'wiki/Note.md'),
      edit('real', 'live-1', 'wiki/Note.md'),
    ])
    // One actionable row, and it must be the live one — showing the shell
    // instead gives the user a card that does nothing.
    expect(cards).toEqual(['real'])
  })

  it('keeps a lone shell so past edits stay visible', () => {
    const cards = renderCards([edit('shell', 'never-landed', 'wiki/Note.md')])
    expect(cards).toEqual(['shell'])
  })

  it('does not hide a proposal for a different file', () => {
    makeLive('live-1', 'a')
    const cards = renderCards([
      edit('other', 'never-landed', 'wiki/Other.md'),
      edit('real', 'live-1', 'wiki/A.md'),
    ])
    expect(cards).toEqual(['other', 'real'])
  })

  it("does not let another message's proposal hide this one", () => {
    // The dedupe key is the file path, so a live proposal elsewhere for the
    // same-looking file must not suppress a shell this message owns.
    makeLive('belongs-to-another-message', 'note')
    const cards = renderCards([edit('mine', 'never-landed', 'wiki/Note.md')])
    expect(cards).toEqual(['mine'])
  })
})
