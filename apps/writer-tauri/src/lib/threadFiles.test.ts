// Regression cover for the turns-file write race. appendVaultFile is
// read-modify-write (read whole file → concat → rewrite whole file), so two
// concurrent writes to the SAME thread's turns file each read the same old
// bytes and the later write clobbers the earlier one — silently dropping a
// turn. threadFiles serialises every mutation of a thread's files per id, so
// concurrent appends/rewrites/deletes can't overwrite each other.
//
// The mock appendVaultFile below is deliberately faithful: it reads, awaits a
// tick, then writes — reproducing the exact race window. Without the per-id
// serialisation these tests fail (a turn goes missing).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatTurn } from '@/chat/types'

const store = vi.hoisted(() => ({ files: new Map<string, string>() }))

vi.mock('@/lib/vault', () => ({
  vaultFileExists: async (p: string) => store.files.has(p),
  readVaultFile: async (p: string) => {
    const c = store.files.get(p)
    if (c === undefined) throw new Error(`not found: ${p}`)
    return c
  },
  // Faithful read-modify-write with an await gap — this is where the race lives.
  appendVaultFile: async (p: string, content: string) => {
    const existing = store.files.get(p) ?? ''
    await new Promise((r) => setTimeout(r, 5))
    store.files.set(p, existing + content)
  },
  writeVaultFile: async (p: string, content: string) => {
    store.files.set(p, content)
  },
  deleteVaultFile: async (p: string) => {
    store.files.delete(p)
  },
  listVaultDir: async () => [],
}))

import {
  appendThreadTurn,
  appendThreadTurns,
  readThreadTurns,
  rewriteThreadTurns,
} from './threadFiles'

function turn(id: string, content: string): ChatTurn {
  return { id, role: 'user', content, ts: 1 }
}

beforeEach(() => {
  store.files.clear()
})

describe('threadFiles turn-write serialisation', () => {
  it('concurrent single appends both survive, in call order', async () => {
    // Fire two appends WITHOUT awaiting between them — the fire-and-forget
    // pattern the store/hook/ChatPanel use. Both must land.
    const a = appendThreadTurn('t1', turn('a', 'first'))
    const b = appendThreadTurn('t1', turn('b', 'second'))
    await Promise.all([a, b])

    const turns = await readThreadTurns('t1')
    expect(turns.map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('a burst of concurrent appends loses nothing', async () => {
    const N = 8
    await Promise.all(
      Array.from({ length: N }, (_, i) => appendThreadTurn('t1', turn(`x${i}`, `c${i}`))),
    )
    const turns = await readThreadTurns('t1')
    expect(turns).toHaveLength(N)
    expect(turns.map((t) => t.id).sort()).toEqual(
      Array.from({ length: N }, (_, i) => `x${i}`).sort(),
    )
  })

  it('append vs rewrite stay ordered — no lost turn, deterministic result', async () => {
    await appendThreadTurn('t1', turn('a', 'first'))
    // rewrite (Regenerate) and a fresh append fired concurrently.
    const r = rewriteThreadTurns('t1', [turn('a', 'first'), turn('b', 'second')])
    const c = appendThreadTurn('t1', turn('c', 'third'))
    await Promise.all([r, c])

    const turns = await readThreadTurns('t1')
    // Whatever the interleave, every turn id is present exactly once and the
    // file parses cleanly (no half-written / clobbered line).
    expect(turns.map((t) => t.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('different thread ids run independently (per-id queue, not global)', async () => {
    await Promise.all([
      appendThreadTurn('t1', turn('a', 'x')),
      appendThreadTurn('t2', turn('b', 'y')),
      appendThreadTurns('t1', [turn('c', 'z')]),
    ])
    expect((await readThreadTurns('t1')).map((t) => t.id)).toEqual(['a', 'c'])
    expect((await readThreadTurns('t2')).map((t) => t.id)).toEqual(['b'])
  })
})
