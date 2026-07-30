// What the vault walks return, pinned before they are merged into one.
//
// Boot walks the whole tree twice — `scanVault` (via its own private
// `listMdRecursive`) for the note catalog, then `listVaultTreeRecursive` for
// the folder/attachment inventory. Merging them is only safe if the merged
// walk emits exactly the same three sets, and the two differ in ways that are
// easy to flatten by accident. These tests exist to make that flattening
// impossible to do silently.
//
// Nothing here was tested before: `scanVault.test.ts` says outright that "the
// I/O orchestration around it … is exercised end-to-end at app boot, not
// unit-tested here".
//
// The harness follows `vaultEcho.test.ts` — a hoisted fake disk behind the
// Tauri fs mocks — with one extension: `readDir` is a real fixture rather than
// a stub returning [], so call counts are meaningful.

import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Entry {
  name: string
  isDirectory: boolean
  isFile: boolean
  isSymlink: boolean
}
const dir = (name: string): Entry => ({
  name,
  isDirectory: true,
  isFile: false,
  isSymlink: false,
})
const file = (name: string): Entry => ({
  name,
  isDirectory: false,
  isFile: true,
  isSymlink: false,
})
/** A symlink: Rust's read_dir does not follow links, so `isFile` is FALSE even
 *  when the target is a regular file. That is the whole reason the two walks
 *  disagree about symlinks. */
const link = (name: string): Entry => ({
  name,
  isDirectory: false,
  isFile: false,
  isSymlink: true,
})

const disk = vi.hoisted(() => ({
  dirs: new Map<string, unknown[]>(),
  text: new Map<string, string>(),
  throwOn: new Set<string>(),
  readDir: vi.fn(),
  exists: vi.fn(),
  readTextFile: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: async (abs: string) => {
    disk.readDir(abs)
    if (disk.throwOn.has(abs)) throw new Error(`EACCES ${abs}`)
    const e = disk.dirs.get(abs)
    if (!e) throw new Error(`ENOTDIR ${abs}`)
    return e
  },
  exists: async (abs: string) => {
    disk.exists(abs)
    return disk.dirs.has(abs) || disk.text.has(abs)
  },
  readTextFile: async (abs: string) => {
    disk.readTextFile(abs)
    return disk.text.get(abs) ?? ''
  },
  readFile: async (abs: string) => new TextEncoder().encode(disk.text.get(abs) ?? ''),
  writeTextFile: async () => {},
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
vi.mock('@/state/settingsStore', () => ({ getActiveVaultPath: () => '/vault' }))
vi.mock('@/state/gitStore', () => ({
  useGitStore: { getState: () => ({ noteActivity: () => {} }) },
}))
// Real module installs a flush timer on import; the walk only needs this one.
vi.mock('@/lib/docFileSync', () => ({ seedLastWrittenPath: () => {} }))

import { listVaultTreeRecursive } from './vault'
import { scanVault } from './scanVault'
import { pathForDoc } from '@/lib/docPaths'

/** One tree covering every classification branch the two walks disagree on.
 *  `locked/` throws from `readDir` when `lockedThrows` — the difference that
 *  today decides whether boot completes at all. */
function buildDisk(lockedThrows: boolean) {
  disk.dirs = new Map<string, Entry[]>([
    [
      '/vault',
      [
        dir('_system'),
        dir('daily'),
        dir('empty'),
        dir('locked'),
        dir('wiki'),
        dir('.git'),
        dir('.octave'),
        file('.DS_Store'),
      ],
    ],
    ['/vault/_system', [file('index.md')]],
    ['/vault/daily', [file('2026-01-01.md')]],
    ['/vault/empty', []],
    ['/vault/locked', [file('hidden.md')]],
    [
      '/vault/wiki',
      [
        file('Note.md'),
        file('Note.marks.json'),
        file('Note.md.tmp'),
        file('photo.png'),
        link('link-note.md'),
        link('link-photo.png'),
        dir('sub'),
      ],
    ],
    ['/vault/wiki/sub', [file('Nested.md')]],
    ['/vault/.git', [file('config')]],
    ['/vault/.octave', [dir('threads')]],
    ['/vault/.octave/threads', [file('t.json')]],
  ])
  disk.text = new Map(
    [
      '_system/index.md',
      'daily/2026-01-01.md',
      'wiki/Note.md',
      'wiki/link-note.md',
      'wiki/sub/Nested.md',
      'locked/hidden.md',
    ].map((rel) => [`/vault/${rel}`, `---\ntitle: x\n---\n\nbody\n`]),
  )
  disk.throwOn = lockedThrows ? new Set(['/vault/locked']) : new Set()
}

/** The note set, expressed as vault-relative paths via the product's own
 *  placement function — `scanVault` returns KnownDocs, and only some types
 *  carry `relPath`. */
async function notePaths(): Promise<string[]> {
  const docs = await scanVault()
  const bySlug = new Map(docs.map((d) => [d.slug, d]))
  return docs
    .map((d) => pathForDoc(d, (s) => bySlug.get(s)))
    .filter((p): p is string => p !== null)
    .sort()
}

beforeEach(() => {
  buildDisk(false)
  disk.readDir.mockClear()
  disk.exists.mockClear()
  disk.readTextFile.mockClear()
})

describe('the vault tree walk (characterization — must survive the merge unchanged)', () => {
  it('returns every folder, parent before child, and no dot-folders', async () => {
    const { dirs } = await listVaultTreeRecursive()
    expect(dirs).toEqual(['_system', 'daily', 'empty', 'locked', 'wiki', 'wiki/sub'])
  })

  it('returns attachments only — not notes, sidecars, temp files, or dot-dir contents', async () => {
    const { files } = await listVaultTreeRecursive()
    expect(files).toEqual(['wiki/photo.png'])
  })

  it('returns every note, and nothing that merely looks like one', async () => {
    expect(await notePaths()).toEqual([
      '_system/index.md',
      'daily/2026-01-01.md',
      'locked/hidden.md',
      'wiki/Note.md',
      'wiki/link-note.md',
      'wiki/sub/Nested.md',
    ])
  })

  // The asymmetry a merged loop is most likely to erase. Hoisting one
  // `entry.isFile` guard around both branches drops the symlinked note;
  // dropping the guard entirely starts surfacing the symlinked attachment.
  // Neither is today's behavior.
  it('includes a symlinked note but excludes a symlinked attachment', async () => {
    const { files } = await listVaultTreeRecursive()
    expect(await notePaths()).toContain('wiki/link-note.md')
    expect(files).not.toContain('wiki/link-photo.png')
  })

  it('never puts the same path in both sets', async () => {
    const { files } = await listVaultTreeRecursive()
    const notes = await notePaths()
    expect(files.filter((f) => notes.includes(f))).toEqual([])
  })

  it('the tree walk reads no file contents — the watcher refresh depends on that', async () => {
    await listVaultTreeRecursive()
    expect(disk.readTextFile).not.toHaveBeenCalled()
  })

  it('the tree walk already survives an unreadable directory', async () => {
    buildDisk(true)
    const { dirs, files } = await listVaultTreeRecursive()
    expect(dirs).toContain('locked')
    expect(files).toEqual(['wiki/photo.png'])
  })
})
