// Accepting a skill update, driven all the way to disk.
//
// `skillProposalStore.test.ts` mocks `@/lib/docFileSync`, so it proves the new
// body reaches the editor and the slug is marked dirty. It cannot prove the two
// things that actually decide whether the user's accept sticks: that the flush
// writes the body, and that `description` — which lives in frontmatter, outside
// the body funnel — comes out on disk at all. That second one was an open
// question in the plan, not a certainty.
//
// So: real docsStore, real docFileSync, real vault.ts, real activeCmEditor,
// fake filesystem.

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
  // writeVaultFile is an atomic write — `.tmp` then rename. Stubbing this out
  // leaves every write stranded in the temp file, which is exactly what the
  // first run of this test did.
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
import { flushDirty, getDirtySlugs } from '@/lib/docFileSync'
import { scanVault } from '@/lib/scanVault'
import { useSkillProposalStore } from './skillProposalStore'

const REL = '_system/agent/skills/existing/SKILL.md'
const ABS = `/vault/${REL}`

/** Stand in for the 500ms flush timer, and wait for it to drain.
 *
 * Driving the flush rather than only awaiting the accept path matters for what
 * this test is FOR: the bug is that the flush later overwrites the accepted
 * skill with the editor's stale body. If nothing flushes, that never happens
 * and the test would fail for the boring reason instead of the real one.
 *
 * `flushDirty` is single-flight, so calling it while the accept path's own
 * `void flushDirty()` is in flight is a no-op — hence the loop rather than one
 * await. */
async function flushUntilSettled(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (getDirtySlugs().length === 0) return
    await flushDirty()
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`flush never settled; still dirty: ${getDirtySlugs().join(',')}`)
}

beforeEach(() => {
  disk.dirs = new Map<string, unknown[]>([
    ['/vault', [entry('_system', 'dir')]],
    ['/vault/_system', [entry('agent', 'dir')]],
    ['/vault/_system/agent', [entry('skills', 'dir')]],
    ['/vault/_system/agent/skills', [entry('existing', 'dir')]],
    ['/vault/_system/agent/skills/existing', [entry('SKILL.md', 'file')]],
  ])
  disk.text = new Map([
    [ABS, '---\ndescription: old when-to-use\ntags:\n  - keep-me\n---\n\nold procedure\n'],
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
  useSkillProposalStore.setState({ byId: {} })
})

describe('accepting a skill update while it is open in the editor', () => {
  it('writes the new body AND the new description to disk', async () => {
    const { docs } = await scanVault()
    useDocsStore.setState({ knownDocs: docs } as never)
    const doc = docs.find((d) => d.relPath === REL)!

    await useDocsStore.getState().ensureHandle(doc.slug)
    await useDocsStore.getState().handles[doc.slug]!.contentReady
    const buf = { text: 'old procedure' }
    registerCmEditor({
      slug: doc.slug,
      getBody: () => buf.text,
      setBody: (md) => {
        buf.text = md
      },
      rejectChange: () => {},
      scrollToChange: () => {},
      isMaterialized: () => false,
    })

    useSkillProposalStore.getState().push({
      pendingId: 'p1',
      runId: 'r1',
      name: 'existing',
      description: 'new when-to-use',
      body: 'new procedure',
      // The skill folder is derived from `updates`, so point it at this one.
      updates: 'existing',
    })
    expect(await useSkillProposalStore.getState().accept('p1')).toBe(true)
    await flushUntilSettled()

    // The editor is the authoritative body, so it must have the new procedure —
    // otherwise the flush would write the old one straight back over it.
    expect(buf.text).toBe('new procedure')

    const onDisk = disk.text.get(ABS)!
    expect(onDisk).toContain('new procedure')
    expect(onDisk).not.toContain('old procedure')
    // Frontmatter: the funnel does not own it, so this is the half that had to
    // be proven rather than assumed.
    expect(onDisk).toContain('description: new when-to-use')
    expect(onDisk).toContain('- keep-me')
    unregisterCmEditor(doc.slug)
  })
})
