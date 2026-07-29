// A message must not re-render because of a proposal that belongs to another
// message.
//
// Every re-render here re-parses that message's whole answer — react-markdown
// memoizes nothing, and the parse is linear in length. Measured against the
// real pipeline: 50 settled messages of 4KB cost 261ms in one synchronous
// commit, 606ms at 10KB. Subscribing to the whole proposal map turns every
// Accept / Reject / arriving proposal / note switch into exactly that commit,
// so the cost of clicking one button scales with how long the conversation is.

import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MessagePart } from '@/chat/types'
import { usePendingChangesStore } from '@/state/pendingChangesStore'
import { PROPOSE_EDIT_TOOLS } from './proposeChangeTool'
import { useLiveEditIds } from './useLiveEditIds'

// The product owns which tool names count as an edit proposal; spelling one
// out here is how the copy drifts.
const editPart = (id: string, pendingId: string): MessagePart =>
  ({
    id,
    ts: 0,
    type: 'tool',
    toolName: PROPOSE_EDIT_TOOLS[0],
    pendingId,
    input: { file_path: `wiki/${id}.md` },
    state: 'output-available',
  }) as unknown as MessagePart

const textPart = (id: string): MessagePart =>
  ({ id, ts: 0, type: 'text', text: 'hello' }) as unknown as MessagePart

/** Mounts the hook and reports how many times it rendered. */
function mount(parts: MessagePart[]) {
  let renders = 0
  let live: ReadonlySet<string> = new Set()
  function Probe() {
    renders++
    live = useLiveEditIds(parts)
    return null
  }
  const root = createRoot(document.createElement('div'))
  act(() => root.render(createElement(Probe)))
  return {
    get renders() {
      return renders
    },
    get live() {
      return live
    },
    unmount: () => act(() => root.unmount()),
  }
}

const pushChange = (pendingId: string, slug: string) =>
  act(() => {
    usePendingChangesStore.getState().push({
      id: pendingId,
      pageSlug: slug,
      source: 'chat',
      edits: [{ before: 'a', after: 'b' }],
    } as never)
  })

beforeEach(() => {
  usePendingChangesStore.setState({ byId: {} })
})

afterEach(() => {
  usePendingChangesStore.setState({ byId: {} })
})

describe('useLiveEditIds', () => {
  it('ignores proposals that belong to another message', () => {
    const probe = mount([textPart('t1'), editPart('e1', 'mine')])
    const before = probe.renders

    pushChange('someone-elses', 'other-note')

    expect(probe.renders).toBe(before)
    probe.unmount()
  })

  it('ignores proposals entirely for a message that has none', () => {
    const probe = mount([textPart('t1'), textPart('t2')])
    const before = probe.renders

    pushChange('a', 'note-a')
    pushChange('b', 'note-b')

    expect(probe.renders).toBe(before)
    probe.unmount()
  })

  it('does re-render when one of its own proposals lands', () => {
    const probe = mount([editPart('e1', 'mine')])
    const before = probe.renders

    pushChange('mine', 'my-note')

    expect(probe.renders).toBeGreaterThan(before)
    expect(probe.live.has('mine')).toBe(true)
    probe.unmount()
  })

  it('reports only the ids that are actually live', () => {
    const probe = mount([editPart('e1', 'landed'), editPart('e2', 'never-landed')])
    pushChange('landed', 'note')

    expect(probe.live.has('landed')).toBe(true)
    expect(probe.live.has('never-landed')).toBe(false)
    probe.unmount()
  })
})
