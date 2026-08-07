// What a long transcript costs to render, and what it costs to touch once it
// is on screen.
//
// The audit lists "ChatPanel maps every turn, no virtualization" as open,
// deferring to a re-measurement after fcc596b7a narrowed PartList's
// subscription. This is that measurement, driven through the real MessageRow
// and the real pendingChangesStore rather than a stand-in.
//
// The sizes are not invented. Across 127 threads in this vault: median 2 turns,
// p90 11, max 48; turn content median 30 chars, p90 591, max 6.4KB. So
// `48 @ 0.6KB` is the worst thread that actually exists here and every row
// below it is headroom.

import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { it } from 'vitest'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
import { MessageRow } from '@/chat/messages/MessageRow'
import { usePendingChangesStore } from '@/state/pendingChangesStore'
import type { ChatTurn } from '@/chat/types'

const body = (kb: number) =>
  Array.from({ length: Math.max(1, Math.round(kb * 8)) }, (_, i) =>
    i % 4 === 0 ? `## Section ${i}` : `Some **markdown** with \`code\` and a [link](http://x/${i}). `.repeat(2),
  ).join('\n\n')

const turn = (i: number, kb: number): ChatTurn => {
  const text = body(kb)
  return ({
    id: `t${i}`, role: 'assistant', status: 'done', ts: i, content: text,
    parts: [{ id: `p${i}`, ts: i, type: 'text', text }],
  }) as unknown as ChatTurn
}

function measure(n: number, kb: number) {
  const turns = Array.from({ length: n }, (_, i) => turn(i, kb))
  const root = createRoot(document.createElement('div'))
  const t0 = performance.now()
  act(() =>
    root.render(
      createElement(
        'div',
        null,
        turns.map((t) => createElement(MessageRow, { key: t.id, turn: t, threadId: 'th' })),
      ),
    ),
  )
  const mountMs = performance.now() - t0

  // What clicking Accept does to the store PartList subscribes to.
  const t1 = performance.now()
  act(() => {
    usePendingChangesStore.getState().push({
      id: 'pc-1', pageSlug: 'note', source: 'chat',
      edits: [{ before: 'a', after: 'b' }],
    } as never)
  })
  const acceptMs = performance.now() - t1

  // A keystroke in the composer re-renders ChatPanel, which re-creates this
  // list element. Same turn objects → React.memo should stop at every row.
  const rerender = () =>
    act(() =>
      root.render(
        createElement(
          'div',
          null,
          turns.map((t) => createElement(MessageRow, { key: t.id, turn: t, threadId: 'th' })),
        ),
      ),
    )
  rerender()
  const t2 = performance.now()
  rerender()
  const keystrokeMs = performance.now() - t2

  act(() => root.unmount())
  usePendingChangesStore.setState({ byId: {} })
  return { mountMs, acceptMs, keystrokeMs }
}

// `process` is Node's, and this app's tsconfig is browser-typed on purpose —
// reached through globalThis rather than pulling @types/node in for a bench.
const node = globalThis as unknown as {
  process?: { env: Record<string, string | undefined>; stderr: { write(s: string): void } }
}

// Gated the way the Rust benches are `#[ignore]`d: it takes seconds and
// asserts nothing, so it stays out of the default run.
//   BENCH=1 npx vitest run src/chat/messages/transcript-bench.test.tsx
it.runIf(!!node.process?.env.BENCH)('transcript render cost', () => {
  const lines: string[] = []
  for (const [n, kb] of [
    [48, 0.6],
    [48, 4],
    [50, 4],
    [50, 10],
    [200, 4],
  ] as const) {
    const { mountMs, acceptMs, keystrokeMs } = measure(n, kb)
    lines.push(
      `${n} msgs @ ${kb}KB: mount ${mountMs.toFixed(0)}ms | ` +
        `store write ${acceptMs.toFixed(1)}ms | keystroke ${keystrokeMs.toFixed(1)}ms`,
    )
  }
  node.process?.stderr.write(`\n${lines.join('\n')}\n`)
})
