// The echo filter, and the one question it has to get right.
//
// Its job is to drop the fsevent our own write just caused. The trap is that
// "did I write this content recently?" and "is this what I currently know the
// file to hold?" agree almost always — and disagree exactly when an external
// tool restores an earlier version. That is not an exotic case: restoring an
// earlier version is what version control is for, and this app runs `git
// revert` itself (the undo-ai-change skill).
//
// The old filter answered the first question, against a 30-second history of
// every hash written. These tests pin the second.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const disk = vi.hoisted(() => ({ files: new Map<string, string>() }))

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: async (abs: string) => {
    const content = disk.files.get(abs)
    if (content === undefined) throw new Error('ENOENT')
    return new TextEncoder().encode(content)
  },
  writeTextFile: async (abs: string, content: string) => void disk.files.set(abs, content),
  writeFile: async (abs: string, bytes: Uint8Array) =>
    void disk.files.set(abs, new TextDecoder().decode(bytes)),
  rename: async (from: string, to: string) => {
    const c = disk.files.get(from)
    if (c === undefined) throw new Error('ENOENT')
    disk.files.delete(from)
    disk.files.set(to, c)
  },
  remove: async (abs: string) => void disk.files.delete(abs),
  mkdir: async () => {},
  exists: async (abs: string) => disk.files.has(abs),
  readDir: async () => [],
  readTextFile: async (abs: string) => disk.files.get(abs) ?? '',
}))
vi.mock('@tauri-apps/api/path', () => ({
  join: async (...parts: string[]) => parts.join('/'),
  dirname: async (p: string) => p.split('/').slice(0, -1).join('/'),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => {} }))
vi.mock('@tauri-apps/plugin-shell', () => ({ open: async () => {} }))
vi.mock('@/state/settingsStore', () => ({ getActiveVaultPath: () => '/vault' }))
vi.mock('@/state/gitStore', () => ({ useGitStore: { getState: () => ({ noteActivity: () => {} }) } }))

import { isDiskContentKnown, writeVaultFile, renameVaultFile } from './vault'

const NOTE = 'wiki/Note.md'
const ABS = `/vault/${NOTE}`

/** An edit made by something that is not us. */
function externalWrite(rel: string, content: string) {
  disk.files.set(`/vault/${rel}`, content)
}

beforeEach(() => {
  disk.files.clear()
})

describe('our own write is recognised', () => {
  it('drops the event our write just caused', async () => {
    await writeVaultFile(NOTE, 'hello')
    expect(await isDiskContentKnown(NOTE)).toBe(true)
  })

  it('stays quiet across a run of writes (no ping-pong)', async () => {
    // The flush ticks every 500ms; every tick must be recognised, or each one
    // comes back as a phantom external change and the app chases its own tail.
    for (const body of ['a', 'ab', 'abc', 'abcd']) {
      await writeVaultFile(NOTE, body)
      expect(await isDiskContentKnown(NOTE)).toBe(true)
    }
  })
})

describe('a real external change is reported', () => {
  it('reports content we never wrote', async () => {
    await writeVaultFile(NOTE, 'ours')
    externalWrite(NOTE, 'theirs')
    expect(await isDiskContentKnown(NOTE)).toBe(false)
  })

  it('reports a REVERT to a body we wrote seconds ago', async () => {
    // The whole reason this filter was rewritten. Under the old rule both V1
    // and V2 sat in a 30-second history, so restoring V1 looked like our own
    // echo and was swallowed: the editor kept V2 and the next flush wrote it
    // back, undoing the undo. Here V1 is no longer what we believe the file
    // holds, so it is reported — no clock involved.
    await writeVaultFile(NOTE, 'V1')
    await writeVaultFile(NOTE, 'V2')
    externalWrite(NOTE, 'V1') // git revert
    expect(await isDiskContentKnown(NOTE)).toBe(false)
  })

  it('reports it even when the revert lands immediately', async () => {
    // Timing is not a factor at all now — there is nothing to outlast.
    await writeVaultFile(NOTE, 'V1')
    await writeVaultFile(NOTE, 'V2')
    externalWrite(NOTE, 'V1')
    expect(await isDiskContentKnown(NOTE)).toBe(false)
    // …and a second, coalesced delivery of that same event does not re-report:
    // the first call adopted V1 as what we now know.
    expect(await isDiskContentKnown(NOTE)).toBe(true)
  })
})

describe('beliefs are per file', () => {
  it('writing content to one file does not vouch for the same content elsewhere', async () => {
    // The old set was keyed by content alone, with no path — its comment sold
    // this as a feature ("path differences stop mattering"). It meant an
    // external write of bytes we happened to have written somewhere else was
    // suppressed on a file we had never touched.
    await writeVaultFile('wiki/A.md', 'shared body')
    externalWrite('wiki/B.md', 'shared body')
    expect(await isDiskContentKnown('wiki/B.md')).toBe(false)
  })
})

describe('files that come and go', () => {
  it('a deleted file is not known', async () => {
    await writeVaultFile(NOTE, 'hello')
    disk.files.delete(ABS)
    expect(await isDiskContentKnown(NOTE)).toBe(false)
  })

  it('a file recreated with its old content is reported, not mistaken for known', async () => {
    await writeVaultFile(NOTE, 'hello')
    disk.files.delete(ABS)
    await isDiskContentKnown(NOTE) // the removal event clears the belief
    externalWrite(NOTE, 'hello')
    expect(await isDiskContentKnown(NOTE)).toBe(false)
  })

  it('a rename carries the belief to the destination', async () => {
    await writeVaultFile(NOTE, 'body')
    await renameVaultFile(NOTE, 'wiki/Renamed.md')
    expect(await isDiskContentKnown('wiki/Renamed.md')).toBe(true)
  })

  it('after a rename the old path is no longer vouched for', async () => {
    await writeVaultFile(NOTE, 'body')
    await renameVaultFile(NOTE, 'wiki/Renamed.md')
    externalWrite(NOTE, 'body') // something recreates the original path
    expect(await isDiskContentKnown(NOTE)).toBe(false)
  })
})
