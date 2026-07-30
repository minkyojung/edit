// Boot has to finish even when part of the vault can't be read.
//
// `BootGate` calls `bootstrap()` un-awaited, so anything that rejects inside it
// is an unhandled rejection: `bootstrapping` never flips false and the app sits
// on its loading spinner forever, with nothing on screen to say why. The note
// walk used to let a failing `readDir` out, so one permission-denied directory
// anywhere in the vault meant the app would not start.
//
// Unlike the fake-store unit tests, this drives the REAL docsStore through the
// REAL scanVault and the REAL vault.ts, against a fake Tauri filesystem — the
// closest a headless run gets to launching the app.

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
  throwOn: new Set<string>(),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: async (abs: string) => {
    if (disk.throwOn.has(abs)) throw new Error(`EACCES: permission denied, ${abs}`)
    const e = disk.dirs.get(abs)
    if (!e) throw new Error(`ENOTDIR ${abs}`)
    return e
  },
  exists: async (abs: string) => disk.dirs.has(abs) || disk.text.has(abs),
  readTextFile: async (abs: string) => disk.text.get(abs) ?? '',
  readFile: async (abs: string) => new TextEncoder().encode(disk.text.get(abs) ?? ''),
  writeTextFile: async (abs: string, c: string) => void disk.text.set(abs, c),
  writeFile: async () => {},
  rename: async () => {},
  remove: async () => {},
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

import { useDocsStore } from './index'
import { pathForDoc } from '@/lib/docPaths'

const NOTE = '---\ntitle: x\n---\n\nbody\n'

beforeEach(() => {
  disk.dirs = new Map<string, unknown[]>([
    ['/vault', [entry('daily', 'dir'), entry('locked', 'dir'), entry('wiki', 'dir')]],
    ['/vault/daily', [entry('2026-01-01.md', 'file')]],
    ['/vault/locked', [entry('hidden.md', 'file')]],
    ['/vault/wiki', [entry('Note.md', 'file')]],
  ])
  disk.text = new Map(
    ['daily/2026-01-01.md', 'wiki/Note.md', 'locked/hidden.md'].map((r) => [
      `/vault/${r}`,
      NOTE,
    ]),
  )
  // The whole point: this directory refuses to be listed.
  disk.throwOn = new Set(['/vault/locked'])
  useDocsStore.setState({
    knownDocs: [],
    knownFolders: [],
    knownFiles: [],
    bootstrapping: true,
  } as never)
})

describe('bootstrap with an unreadable directory in the vault', () => {
  it('finishes booting, and catalogues everything it could reach', async () => {
    await useDocsStore.getState().bootstrap()

    // The assertion that matters: the spinner comes down. Before the fix this
    // stayed true forever because scanVault rejected out of bootstrap.
    expect(useDocsStore.getState().bootstrapping).toBe(false)

    // Through the product's own placement function — a `wiki:` doc carries no
    // relPath, its path is derived from its title.
    const docs = useDocsStore.getState().knownDocs
    const bySlug = new Map(docs.map((d) => [d.slug, d]))
    const paths = docs.map((d) => pathForDoc(d, (s) => bySlug.get(s))).sort()
    expect(paths).toEqual(['daily/2026-01-01.md', 'wiki/Note.md'])
    // The unreadable subtree is simply absent — not a crash, not a hang.
    expect(paths).not.toContain('locked/hidden.md')
    // The folder itself still shows in the tree; only its contents are unknown.
    expect(useDocsStore.getState().knownFolders).toContain('locked')
  })
})
