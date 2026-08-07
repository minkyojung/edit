// The rename fix, driven all the way to disk.
//
// `renameWikilinks.integration.test.ts` mocks `@/lib/docFileSync`, so it proves
// the rewrite reaches the editor and the mirror and that the slug is marked
// dirty — but it stops there. The user's question is whether the unsaved
// sentence survives to the FILE. That needs the real flush.
//
// So this one mocks nothing above Tauri: real docsStore, real docFileSync,
// real scanVault, real vault.ts, real activeCmEditor, fake filesystem.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const entry = (name: string, kind: 'dir' | 'file') => ({
  name,
  isDirectory: kind === 'dir',
  isFile: kind === 'file',
  isSymlink: false,
})

const disk = vi.hoisted(() => ({
  dirs: new Map<string, unknown[]>(),
  text: new Map<string, string>(),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: async (abs: string) => {
    const e = disk.dirs.get(abs)
    if (!e) throw new Error(`ENOTDIR ${abs}`)
    return e
  },
  exists: async (abs: string) => disk.dirs.has(abs) || disk.text.has(abs),
  readTextFile: async (abs: string) => {
    const v = disk.text.get(abs)
    if (v === undefined) throw new Error(`ENOENT ${abs}`)
    return v
  },
  readFile: async (abs: string) => {
    const v = disk.text.get(abs)
    if (v === undefined) throw new Error(`ENOENT ${abs}`)
    return new TextEncoder().encode(v)
  },
  writeTextFile: async (abs: string, c: string) => void disk.text.set(abs, c),
  writeFile: async (abs: string, b: Uint8Array) =>
    void disk.text.set(abs, new TextDecoder().decode(b)),
  rename: async (from: string, to: string) => {
    const c = disk.text.get(from)
    if (c === undefined) return
    disk.text.delete(from)
    disk.text.set(to, c)
  },
  remove: async (abs: string) => void disk.text.delete(abs),
  mkdir: async () => {},
}))
vi.mock('@tauri-apps/api/path', () => ({
  join: async (...parts: string[]) => parts.join('/'),
  dirname: async (p: string) => p.split('/').slice(0, -1).join('/'),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => {} }))
vi.mock('@tauri-apps/plugin-shell', () => ({ open: async () => {} }))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }))
vi.mock('@/state/settingsStore', () => ({
  getActiveVaultPath: () => '/vault',
  useSettingsStore: { getState: () => ({}) },
}))
vi.mock('@/state/gitStore', () => ({
  useGitStore: { getState: () => ({ noteActivity: () => {} }) },
}))

import { useDocsStore } from '@/state/docsStore'
import { registerCmEditor, unregisterCmEditor } from '@/state/activeCmEditor'
import { getDirtySlugs } from '@/lib/docFileSync'
import { updateWikilinksForRename } from './renameWikilinks'

/** Wait for the flush to actually finish.
 *
 * The fix fires `void flushDirty()` itself, and `flushDirty` is single-flight —
 * a second call while one is running just sets `flushQueued` and returns. So
 * `await flushDirty()` here would return instantly and assert against a file
 * nothing had written yet: green, and meaningless. Poll the product's own dirty
 * set instead. */
async function settled(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (getDirtySlugs().length === 0) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`flush never settled; still dirty: ${getDirtySlugs().join(',')}`)
}

const LINKER = '/vault/inbox/Linker.md'
const UNSAVED = 'see [[Tom]] and a sentence I have only just typed'

beforeEach(() => {
  disk.dirs = new Map<string, unknown[]>([
    ['/vault', [entry('inbox', 'dir'), entry('wiki', 'dir')]],
    ['/vault/inbox', [entry('Linker.md', 'file')]],
    ['/vault/wiki', [entry('Tom.md', 'file')]],
  ])
  disk.text = new Map([
    // What is on disk is BEHIND the editor — the last flush wrote this.
    [LINKER, '---\ntags:\n  - keep-me\n---\n\nsee [[Tom]]\n'],
    ['/vault/wiki/Tom.md', '---\n---\n\nI am Tom\n'],
  ])
  useDocsStore.setState({
    knownDocs: [],
    knownFolders: [],
    knownFiles: [],
    handles: {},
    status: {},
    openSlugs: [],
    openPaths: [],
  } as never)
})

describe('renaming a note, with an inbound linker open and unsaved', () => {
  it('the unsaved sentence reaches disk, together with the rewritten link', async () => {
    // Build the catalog the way boot does, so the docs are real KnownDocs.
    const { docs } = await (await import('./scanVault')).scanVault()
    useDocsStore.setState({ knownDocs: docs } as never)
    const linker = docs.find((d) => d.relPath === 'inbox/Linker.md')!
    const tom = docs.find((d) => d.type.startsWith('wiki:'))!

    // Open the linker the way the app does, then put unflushed text in its
    // editor — the state that used to be destroyed.
    await useDocsStore.getState().ensureHandle(linker.slug)
    await useDocsStore.getState().handles[linker.slug]!.contentReady
    const buf = { text: UNSAVED }
    registerCmEditor({
      slug: linker.slug,
      getBody: () => buf.text,
      setBody: (md) => {
        buf.text = md
      },
      rejectChange: () => {},
      scrollToChange: () => {},
      isMaterialized: () => false,
    })

    await updateWikilinksForRename(tom.slug, 'Tom', 'Thomas')
    await settled()

    const onDisk = disk.text.get(LINKER)!
    expect(onDisk).toContain('[[Thomas]]') // the rename landed
    expect(onDisk).toContain('a sentence I have only just typed') // and so did the typing
    expect(onDisk).not.toContain('[[Tom]]')
    expect(onDisk).toContain('- keep-me') // frontmatter the app does not own
    unregisterCmEditor(linker.slug)
  })
})
